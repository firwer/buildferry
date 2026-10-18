// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../src/web/App.js";
import { accountSchema, providerSchema } from "../src/shared/contracts.js";
import { newAccount } from "../src/server/auth.js";
import { currentPeriod } from "../src/server/routing.js";
import { api, loadSession } from "../src/web/api.js";
import { fixture, projectId, response, sampleApp } from "./fixtures.js";
import { z } from "zod";
import { project, worker, sourceSha } from "./execution-fixtures.js";

const apps: Awaited<ReturnType<typeof fixture>>[] = [];
const clients: QueryClient[] = [];
let cookie = "owner-session";
beforeEach(() => {
  cookie = "owner-session";
  window.history.replaceState({}, "", "/");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
});
afterEach(async () => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(signedIn = true, fetcher?: typeof fetch) {
  const app = await fixture({ signedIn, fetcher });
  apps.push(app);
  if (signedIn) app.store.setSecret("github-app", sampleApp);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const pathname = String(url);
      const result = await app.server.inject({
        method: (init?.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE",
        url: pathname,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          origin: app.config.publicUrl,
        },
        cookies: { bf_session: cookie },
        payload: typeof init?.body === "string" ? init.body : undefined,
      });
      const setCookie = result.cookies.find(
        (value) => value.name === "bf_session",
      );
      if (setCookie) cookie = setCookie.value;
      return new Response(result.statusCode === 204 ? null : result.body, {
        status: result.statusCode,
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return { ...app, client, user: userEvent.setup() };
}

describe("dashboard journeys", () => {
  it("shows real empty states and connects an approved workload without seeded runs", async () => {
    const { user, execution, store } = await mount();
    vi.spyOn(execution.service.credentials, "token").mockResolvedValue(
      "owner-user-token",
    );
    vi.spyOn(execution.service.github, "installation").mockResolvedValue({
      id: 201,
      app_id: 10,
    });
    vi.spyOn(execution.service.github, "repository").mockResolvedValue({
      id: 101,
      full_name: "owner/source",
      private: true,
      archived: false,
      disabled: false,
      default_branch: "main",
      owner: { id: 1, login: "owner" },
    });
    await user.click(
      await screen.findByRole("button", { name: "Workloads and runs" }),
    );
    expect(
      await screen.findByRole("heading", { name: "No runs yet" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Connect workload" }));
    await user.type(screen.getByLabelText("Source repository"), "owner/source");
    await user.type(screen.getByLabelText("Workload name"), "Build");
    await user.type(
      screen.getByLabelText(/Approved commands, one per line/),
      "npm ci\nnpm test",
    );
    await user.clear(screen.getByLabelText("Maximum minutes"));
    await user.type(screen.getByLabelText("Maximum minutes"), "10");
    await user.click(screen.getByLabelText("Run on default branch updates"));
    await user.click(screen.getByRole("button", { name: "Save workload" }));
    expect(
      await screen.findByRole("button", { name: "Run Build" }),
    ).toBeTruthy();
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM records WHERE kind='job'")
        .get()?.n,
    ).toBe(0);
    expect(execution.service.projects()[0]).toMatchObject({
      repositoryId: 101,
      recipe: { commands: ["npm ci", "npm test"] },
      onPush: true,
    });
  });

  it("queues a pinned benchmark, preserves the prior recipe on edits and cancels safely", async () => {
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ id: 501 }));
    const { user, execution, store } = await mount(true, providerFetch);
    store.put("project", project.id, project);
    vi.spyOn(execution.service.github, "token").mockResolvedValue(
      "installation-token",
    );
    vi.spyOn(execution.service.github, "ref").mockResolvedValue(sourceSha);
    await user.click(
      await screen.findByRole("button", { name: "Workloads and runs" }),
    );
    await user.click(await screen.findByRole("button", { name: "Run Build" }));
    await user.type(
      screen.getByLabelText("Commit revision (optional)"),
      sourceSha,
    );
    await user.selectOptions(screen.getByLabelText("Capacity"), "ubicloud");
    await user.click(screen.getByRole("button", { name: "Queue run" }));
    expect(
      await screen.findByRole("button", { name: "Cancel run" }),
    ).toBeTruthy();
    expect(execution.service.jobs()[0]).toMatchObject({
      sourceSha,
      route: "ubicloud",
      state: "queued",
    });
    await user.click(screen.getByRole("button", { name: "Edit Build" }));
    await user.clear(screen.getByLabelText(/Approved commands, one per line/));
    await user.type(
      screen.getByLabelText(/Approved commands, one per line/),
      "npm run build",
    );
    await user.click(screen.getByRole("button", { name: "Save workload" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(execution.service.jobs()[0]?.recipe.commands).toEqual([
      "npm ci",
      "npm test",
    ]);
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("cancelled")).toBeTruthy();
    expect(execution.service.jobs()[0]).toMatchObject({
      state: "cancelled",
      cancellationConfirmed: true,
    });
  });

  it("manages the owner's explicit worker approvals", async () => {
    const { user, store, client, execution } = await mount();
    store.put("project", project.id, project);
    const account = store.get("account", "1", accountSchema);
    if (!account) throw new Error("Missing fixture account");
    store.put("account", "1", {
      ...account,
      settings: { ...account.settings, workerRepository: "buildferry-ci" },
    });
    await client.invalidateQueries({ queryKey: ["dashboard"] });
    const provision = vi
      .spyOn(execution.service, "provisionWorker")
      .mockImplementation(async (_id, allowedProjects) => {
        const changed = { ...worker, allowedProjects: [...allowedProjects] };
        store.put("worker", "1", changed);
        return changed;
      });
    await user.click(
      await screen.findByRole("button", { name: "Team accounts" }),
    );
    await user.click(await screen.findByLabelText("owner/source / Build"));
    await user.click(
      screen.getByRole("button", {
        name: "Install worker and approve projects",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Save project approvals" }),
    ).toBeTruthy();
    expect(provision).toHaveBeenCalledWith(1, [project.id]);
    await user.click(screen.getByLabelText("owner/source / Build"));
    await user.click(
      screen.getByRole("button", { name: "Save project approvals" }),
    );
    await waitFor(() => expect(provision).toHaveBeenLastCalledWith(1, []));
  });
  it("navigates the workspace, previews waiting jobs, and retains every planned suite", async () => {
    const { user } = await mount();
    await screen.findByRole("heading", { name: /Your team's capacity/ });
    await user.click(screen.getByRole("button", { name: "Routing preview" }));
    await user.clear(screen.getByLabelText("Parallel jobs"));
    await user.type(screen.getByLabelText("Parallel jobs"), "2");
    await user.clear(screen.getByLabelText("Maximum minutes per job"));
    await user.type(screen.getByLabelText("Maximum minutes per job"), "5");
    await user.selectOptions(screen.getByLabelText("Memory per job"), "16");
    await user.clear(screen.getByLabelText("Total spend limit ($)"));
    await user.type(screen.getByLabelText("Total spend limit ($)"), "0.2");
    await user.click(
      screen.getByRole("button", { name: "Preview assignments" }),
    );
    expect((await screen.findAllByText("Waiting for capacity")).length).toBe(2);
    await user.click(screen.getByText("Why other capacity may be unavailable"));
    expect(
      screen.getByText("The owner has not confirmed the allowance."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Test planner" }));
    await user.clear(screen.getByLabelText("Suites and seconds"));
    await user.type(
      screen.getByLabelText("Suites and seconds"),
      "orders.test, 90\nauth.test, 30",
    );
    await user.clear(screen.getByLabelText("Parallel groups"));
    await user.type(screen.getByLabelText("Parallel groups"), "2");
    await user.click(
      screen.getByRole("button", { name: "Compare test groups" }),
    );
    expect(await screen.findByText("orders.test")).toBeTruthy();
    expect(screen.getByText("auth.test")).toBeTruthy();
    expect(screen.getByText("1.5 min of tests in parallel")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Team accounts" }));
    expect(screen.getByRole("heading", { name: "Team accounts" })).toBeTruthy();
  });

  it("claims an installation and prepares the app manifest without exposing credentials", async () => {
    const { user, store } = await mount(false);
    await user.type(await screen.findByLabelText("Setup code"), "wrong");
    await user.click(screen.getByRole("button", { name: "Continue setup" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "incorrect",
    );
    await user.clear(screen.getByLabelText("Setup code"));
    await user.type(screen.getByLabelText("Setup code"), "fixture-claim-code");
    await user.click(screen.getByRole("button", { name: "Continue setup" }));
    await user.clear(await screen.findByLabelText("GitHub App name"));
    await user.type(
      screen.getByLabelText("GitHub App name"),
      "BuildFerry Example",
    );
    await user.click(
      screen.getByRole("button", { name: "Prepare GitHub connection" }),
    );
    const next = await screen.findByRole("button", {
      name: "Continue on GitHub",
    });
    const form = next.closest("form");
    expect(form?.action).toContain(
      "https://github.com/settings/apps/new?state=",
    );
    const hidden = form?.querySelector<HTMLInputElement>(
      'input[name="manifest"]',
    );
    expect(JSON.parse(hidden?.value ?? "{}").default_permissions.plan).toBe(
      "read",
    );
    expect(store.secret("github-app", z.object({}))).toBeNull();
  });

  it("edits the owner's limits, preserves consent, and refreshes the connection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).includes("/settings/billing/")
        ? response({ usageItems: [] })
        : response({
            private: true,
            archived: false,
            disabled: false,
            owner: { id: 1 },
          }),
    );
    const { user, store } = await mount(true, fetcher);
    store.setSecret("github-user:1", {
      access_token: "test-token",
      expires_at: null,
    });
    await user.click(await screen.findByRole("button", { name: "Edit owner" }));
    for (const [label, value] of [
      ["Included minutes", "3000"],
      ["Contribution limit", "500"],
      ["Personal reserve", "400"],
      ["Priority level", "2"],
      ["Share weight", "3"],
      ["Parallel jobs", "2"],
    ]) {
      const input = screen.getByLabelText(label ?? "");
      await user.clear(input);
      await user.type(input, value ?? "");
    }
    await user.type(
      screen.getByLabelText(/Private CI repository name/),
      "buildferry-ci",
    );
    await user.selectOptions(
      screen.getByLabelText("Contribution status"),
      "paused",
    );
    await user.click(
      screen.getByLabelText(
        "I confirm this allowance resets each calendar month.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store.get("account", "1", accountSchema)?.settings).toMatchObject({
      state: "paused",
      priority: 2,
      weight: 3,
      concurrency: 2,
      contributionMinutes: 500,
      allowanceConfirmed: true,
    });
    await user.click(screen.getByRole("button", { name: "Refresh owner" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  });

  it("connects, refreshes and removes a provider with its entered price and budget", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).endsWith("/github")
          ? response({ count: 1, items: [{ id: "install", name: "owner" }] })
          : response({ id: projectId, name: "Example cloud" }),
      );
    const { user, store } = await mount(true, fetcher);
    await user.click(
      await screen.findByRole("button", { name: "Connections" }),
    );
    expect(
      screen.getByRole("heading", { name: "Add your fallback provider" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Connect Ubicloud" }));
    await user.type(screen.getByLabelText("Project ID"), projectId);
    await user.type(
      screen.getByLabelText("Project access token"),
      "fixture-ubicloud-token",
    );
    await user.selectOptions(
      screen.getByLabelText("Runner size"),
      "ubicloud-standard-8",
    );
    await user.clear(screen.getByLabelText("Priority level"));
    await user.type(screen.getByLabelText("Priority level"), "3");
    await user.type(screen.getByLabelText(/Actual rate per minute/), "0.008");
    await user.clear(screen.getByLabelText("Monthly spend limit ($)"));
    await user.type(screen.getByLabelText("Monthly spend limit ($)"), "5");
    await user.click(
      screen.getByRole("button", { name: "Verify and save connection" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Example cloud" }),
    ).toBeTruthy();
    expect(store.get("provider", projectId, providerSchema)).toMatchObject({
      rateMicros: 8000,
      budgetMicros: 5_000_000,
      runner: "ubicloud-standard-8",
      priority: 3,
    });
    await user.click(
      screen.getByRole("button", { name: "Refresh Example cloud" }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(store.list("provider", providerSchema)).toHaveLength(0),
    );
  });

  it("creates a one-use invitation and allows only the owner to edit its contribution", async () => {
    const { user, store } = await mount();
    store.put("account", "2", {
      ...newAccount(2, "teammate", "member"),
      period: currentPeriod(),
    });
    await user.click(
      await screen.findByRole("button", { name: "Team accounts" }),
    );
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    const input = await screen.findByLabelText<HTMLInputElement>(
      "One-use invitation link",
    );
    expect(
      store.hasInvite(new URL(input.value).searchParams.get("invite") ?? ""),
    ).toBe(true);
    await user.click(input);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(screen.queryByRole("button", { name: "Edit teammate" })).toBeNull();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(
      await screen.findByRole("button", { name: "Disconnect account" }),
    );
    await waitFor(() =>
      expect(store.get("account", "2", accountSchema)).toBeNull(),
    );
  });

  it("shows provider errors without hiding the form or its entered values", async () => {
    const { user } = await mount();
    await user.click(
      await screen.findByRole("button", { name: "Connections" }),
    );
    await user.click(screen.getByRole("button", { name: "Connect Ubicloud" }));
    await user.type(screen.getByLabelText("Project ID"), projectId);
    await user.type(
      screen.getByLabelText("Project access token"),
      "invalid-provider-token",
    );
    await user.type(screen.getByLabelText(/Actual rate per minute/), "0.004");
    await user.click(
      screen.getByRole("button", { name: "Verify and save connection" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not be reached",
    );
    expect(
      within(screen.getByRole("dialog")).getByLabelText<HTMLInputElement>(
        "Project ID",
      ).value,
    ).toBe(projectId);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("requires a fresh authenticated session for browser mutations and validates responses", async () => {
    const { store } = await mount();
    await screen.findByRole("heading", { name: /Your team's capacity/ });
    await loadSession();
    expect(
      await api("/api/invitations", z.object({ url: z.string() }), "POST", {}),
    ).toHaveProperty("url");
    store.deleteSession(cookie);
    await expect(
      api("/api/invitations", z.object({ url: z.string() }), "POST", {}),
    ).rejects.toThrow("Sign in");
  });
});
