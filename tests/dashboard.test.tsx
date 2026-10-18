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
import { scryptSync } from "node:crypto";

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

async function mount(
  signedIn = true,
  fetcher?: typeof fetch,
  config?: NonNullable<Parameters<typeof fixture>[0]>["config"],
) {
  const app = await fixture({ signedIn, fetcher, config });
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
  it("keeps GitHub account connection separate from administrator password sign-in", async () => {
    const salt = Buffer.alloc(32, 7);
    const password = "synthetic-admin-password";
    const { user } = await mount(true, undefined, {
      admin: {
        username: "admin",
        salt,
        passwordHash: scryptSync(password, salt, 64),
      },
    });
    expect(await screen.findByText("You are all set")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accounts" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Return to sign in" }));
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), password);
    await user.click(screen.getByRole("button", { name: /^Sign in$/ }));
    expect(
      await screen.findByRole("button", { name: "Accounts" }),
    ).toBeTruthy();
  });
  it("navigates the four administrator pages without legacy preview tools", async () => {
    const { user } = await mount();
    expect(
      await screen.findByRole("heading", { name: "Repositories", level: 1 }),
    ).toBeTruthy();
    for (const label of ["Repositories", "Accounts", "Providers", "Runs"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(
      screen.queryByRole("button", { name: "Routing preview" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Test planner" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Runs" }));
    expect(
      await screen.findByRole("heading", { name: "Runs", level: 1 }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "No native runs yet" }),
    ).toBeTruthy();
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
    await user.click(await screen.findByRole("button", { name: "Accounts" }));
    await user.click(await screen.findByRole("button", { name: "Edit owner" }));
    await user.click(screen.getByText("Advanced settings"));
    for (const [label, value] of [
      ["Monthly minutes", "3000"],
      ["Minutes available to BuildFerry", "500"],
      ["Keep for other work", "400"],
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
    await user.click(await screen.findByRole("button", { name: "Providers" }));
    expect(
      screen.getByRole("heading", { name: "Add your fallback provider" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Connect Ubicloud" }));
    expect(
      screen.getByLabelText<HTMLSelectElement>("Default machine").value,
    ).toBe("ubicloud-standard-2");
    await user.type(screen.getByLabelText("Project ID"), projectId);
    await user.type(
      screen.getByLabelText("Project access token"),
      "fixture-ubicloud-token",
    );
    await user.selectOptions(
      screen.getByLabelText("Default machine"),
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
      screen.getByRole("button", { name: "Edit Example cloud" }),
    );
    expect(screen.queryByLabelText("Project access token")).toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Default machine"),
      "ubicloud-standard-2",
    );
    expect(
      screen.getByLabelText<HTMLInputElement>(/Actual rate per minute/).value,
    ).toBe("");
    await user.type(screen.getByLabelText(/Actual rate per minute/), "0.002");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(store.get("provider", projectId, providerSchema)).toMatchObject({
      runner: "ubicloud-standard-2",
      rateMicros: 2000,
      budgetMicros: 5_000_000,
      machineRates: [{ runner: "ubicloud-standard-8", rateMicros: 8000 }],
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

  it("lets the administrator edit and disconnect connected accounts", async () => {
    const { user, store } = await mount();
    store.put("account", "2", {
      ...newAccount(2, "teammate", "member"),
      period: currentPeriod(),
    });
    await user.click(await screen.findByRole("button", { name: "Accounts" }));
    expect(
      await screen.findByRole("heading", { name: "Accounts", level: 1 }),
    ).toBeTruthy();
    await user.click(
      await screen.findByRole("button", { name: "Edit teammate" }),
    );
    await user.clear(screen.getByLabelText("Keep for other work"));
    await user.type(screen.getByLabelText("Keep for other work"), "450");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      store.get("account", "2", accountSchema)?.settings.reserveMinutes,
    ).toBe(450);
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
    await user.click(await screen.findByRole("button", { name: "Providers" }));
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
    await screen.findByRole("heading", { name: "Repositories", level: 1 });
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
