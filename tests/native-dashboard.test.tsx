// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../src/shared/contracts.js";
import type {
  NativeDashboard,
  RouteOverride,
  RoutePolicy,
} from "../src/shared/native.js";
import { newAccount } from "../src/server/auth.js";
import { Repositories } from "../src/web/Repositories.js";
import { Runs, WorkerSetup } from "../src/web/Workloads.js";
import {
  nativeDashboardFixture,
  nativeSession,
  nativeWorker,
} from "./native-ui-fixtures.js";

type SaveRequest = {
  enabled: boolean;
  policy: RoutePolicy;
  overrides: Record<string, RouteOverride>;
};

type FetchState = {
  dashboard: NativeDashboard;
  requests: Array<{ path: string; method: string; body: unknown }>;
  failSave?: boolean;
  nativeError?: boolean;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function nativeFetch(state: FetchState) {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    state.requests.push({ path, method, body });
    if (state.nativeError && path === "/api/native") {
      return json({ error: "Native inventory unavailable." }, 500);
    }
    if (path === "/api/native" && method === "GET") {
      return json(state.dashboard);
    }
    if (path === "/api/native/refresh" && method === "POST") {
      return json(state.dashboard);
    }
    if (
      path.startsWith("/api/native/repositories/") &&
      path.includes("/workflows/") &&
      method === "PUT"
    ) {
      if (state.failSave) {
        return json({ error: "Workflow settings could not be saved." }, 500);
      }
      const saved = body as SaveRequest;
      const workflowId = Number(path.split("/")[6]);
      state.dashboard = {
        ...state.dashboard,
        repositories: state.dashboard.repositories.map((repository) => ({
          ...repository,
          workflows: repository.workflows.map((workflow) =>
            workflow.id === workflowId ? { ...workflow, ...saved } : workflow,
          ),
        })),
      };
      const repository = state.dashboard.repositories[0];
      return json(repository);
    }
    if (path === "/api/native/accounts/1/worker" && method === "POST") {
      const installed = {
        ...nativeWorker,
        nativeSha: "c".repeat(40),
        ready: true,
      };
      state.dashboard = { ...state.dashboard, workers: [installed] };
      return json(installed);
    }
    if (
      path.startsWith("/api/native/runs/") &&
      path.endsWith("/cancel") &&
      method === "POST"
    ) {
      const id = path.split("/")[4];
      const cancelled = state.dashboard.runs.map((run) =>
        run.id === id
          ? {
              ...run,
              state: "cancelled" as const,
              sourceConclusion: "cancelled",
              cancellationConfirmed: true,
            }
          : run,
      );
      state.dashboard = { ...state.dashboard, runs: cancelled };
      return json(cancelled[0]);
    }
    return json({ error: "Unexpected request: " + method + " " + path }, 500);
  });
}

function mount(ui: React.ReactNode, state: FetchState) {
  vi.stubGlobal("fetch", nativeFetch(state));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native repository workflow UI", () => {
  it("shows real workflows, dependency edges, jobs and unsupported reasons", async () => {
    const state: FetchState = {
      dashboard: nativeDashboardFixture(),
      requests: [],
    };
    const { user } = mount(<Repositories session={nativeSession} />, state);
    expect(
      await screen.findByRole("heading", { name: "Repositories", level: 1 }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Open owner/source" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText(".github/workflows/ci.yml").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", {
        name: /Build job\. Needs checkout\. Native integration connected\./,
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("Native connected").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reusable workflow").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Unsupported").length).toBeGreaterThan(0);
    expect(screen.getByText("Env: production")).toBeTruthy();
    await user.click(
      await screen.findByRole("button", {
        name: "Configure Windows tests job",
      }),
    );
    expect(
      screen.getAllByText(
        "This job needs a different operating system or processor.",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("saves ordered workflow defaults and preserves existing job overrides", async () => {
    const dashboard = nativeDashboardFixture();
    const workflow = dashboard.repositories[0]?.workflows[0];
    if (workflow) workflow.overrides = { build: { memoryGiB: 16 } };
    const state: FetchState = { dashboard, requests: [] };
    const { user } = mount(<Repositories session={nativeSession} />, state);
    await user.click(
      await screen.findByRole("button", { name: "Move Ubicloud up" }),
    );
    const minutes = screen.getByLabelText("Maximum minutes per job");
    await user.clear(minutes);
    await user.type(minutes, "45");
    await user.click(
      screen.getByRole("button", { name: "Save workflow settings" }),
    );
    await waitFor(() =>
      expect(state.requests.some((request) => request.method === "PUT")).toBe(
        true,
      ),
    );
    const saved = state.requests.find((request) => request.method === "PUT")
      ?.body as SaveRequest;
    expect(saved.policy.providers).toEqual(["ubicloud", "github"]);
    expect(saved.policy.maxMinutes).toBe(45);
    expect(saved.overrides).toEqual({ build: { memoryGiB: 16 } });
  });

  it("stores only explicit job overrides and can return a job to inheritance", async () => {
    const state: FetchState = {
      dashboard: nativeDashboardFixture(),
      requests: [],
    };
    const { user } = mount(<Repositories session={nativeSession} />, state);
    await user.click(
      await screen.findByRole("button", { name: "Configure Build job" }),
    );
    expect(
      screen.getByText("Workflow default: GitHub-hosted → Ubicloud"),
    ).toBeTruthy();
    await user.click(screen.getByLabelText("Override providers"));
    await user.click(
      screen.getByRole("button", { name: "Remove GitHub-hosted" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Ubicloud machine override"),
      "ubicloud-standard-4",
    );
    await user.click(screen.getByRole("button", { name: "Save job override" }));
    await waitFor(() =>
      expect(
        state.requests.filter((request) => request.method === "PUT"),
      ).toHaveLength(1),
    );
    const saved = state.requests.find((request) => request.method === "PUT")
      ?.body as SaveRequest;
    expect(saved.overrides.build).toEqual({
      providers: ["ubicloud"],
      ubicloudRunner: "ubicloud-standard-4",
    });
    expect(saved.overrides.build).not.toHaveProperty("memoryGiB");
    await user.click(
      await screen.findByRole("button", { name: "Use workflow defaults" }),
    );
    await waitFor(() =>
      expect(
        state.requests.filter((request) => request.method === "PUT"),
      ).toHaveLength(2),
    );
    const reset = state.requests.filter(
      (request) => request.method === "PUT",
    )[1]?.body as SaveRequest;
    expect(reset.overrides).toEqual({});
  });

  it("keeps entered override values visible when saving fails", async () => {
    const state: FetchState = {
      dashboard: nativeDashboardFixture(),
      requests: [],
      failSave: true,
    };
    const { user } = mount(<Repositories session={nativeSession} />, state);
    await user.click(
      await screen.findByRole("button", { name: "Configure Build job" }),
    );
    await user.click(screen.getByLabelText("Override memory"));
    expect(
      screen.getByLabelText<HTMLInputElement>("Override memory").checked,
    ).toBe(true);
    const memory = screen.getByLabelText<HTMLInputElement>(
      "Memory per job (GB)",
    );
    await user.clear(memory);
    await user.type(memory, "16");
    await user.click(screen.getByRole("button", { name: "Save job override" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Workflow settings could not be saved.",
    );
    expect(memory.value).toBe("16");
  });

  it("shows native run history with source links, worker machine and cancellation", async () => {
    const state: FetchState = {
      dashboard: nativeDashboardFixture(),
      requests: [],
    };
    const { user } = mount(<Runs />, state);
    expect(
      await screen.findByRole("heading", { name: "Run history" }),
    ).toBeTruthy();
    expect(await screen.findByText("owner/buildferry-ci")).toBeTruthy();
    expect(await screen.findByText(/4 CPUs \/ 16 GB/)).toBeTruthy();
    const source = screen.getByRole("link", { name: /Open GitHub run/ });
    expect(source.getAttribute("href")).toContain("/actions/runs/501");
    await user.click(screen.getByRole("button", { name: "Cancel workflow" }));
    await waitFor(() =>
      expect(
        state.requests.some(
          (request) =>
            request.path ===
              "/api/native/runs/2f7d56b4-2cef-4d3d-8bdd-a83c72cb4db5/cancel" &&
            request.method === "POST",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("cancelled")).toBeTruthy();
    expect(screen.getByText("Cancellation confirmed")).toBeTruthy();
  });

  it("installs the native runner without a project recipe selection", async () => {
    const base = newAccount(1, "owner", "owner");
    const dashboard: Dashboard = {
      accounts: [
        {
          ...base,
          settings: { ...base.settings, workerRepository: "buildferry-ci" },
        },
      ],
      providers: [],
      candidates: [],
      period: "2026-10",
      activity: [],
    };
    const state: FetchState = {
      dashboard: nativeDashboardFixture(),
      requests: [],
    };
    const { user } = mount(
      <WorkerSetup data={dashboard} session={nativeSession} />,
      state,
    );
    expect(await screen.findByText("Ready")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Install runner" }));
    await waitFor(() =>
      expect(
        state.requests.some(
          (request) =>
            request.path === "/api/native/accounts/1/worker" &&
            request.method === "POST",
        ),
      ).toBe(true),
    );
    expect(screen.queryByText("Projects this worker can run")).toBeNull();
  });

  it("shows genuine empty and inventory error states", async () => {
    const empty: FetchState = {
      dashboard: { repositories: [], runs: [], workers: [] },
      requests: [],
    };
    const first = mount(<Repositories session={nativeSession} />, empty);
    expect(
      await screen.findByRole("heading", { name: "No repositories connected" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Manage GitHub App access/ }),
    ).toBeTruthy();
    first.client.clear();
    cleanup();
    const failed: FetchState = {
      dashboard: nativeDashboardFixture(),
      requests: [],
      nativeError: true,
    };
    mount(<Repositories session={nativeSession} />, failed);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Native inventory unavailable.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
