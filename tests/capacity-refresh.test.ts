import { afterEach, expect, it, vi } from "vitest";
import { CapacityRefresh } from "../src/server/capacity-refresh.js";
import { accountSchema, providerSchema } from "../src/shared/contracts.js";
import { executionFixture } from "./execution-fixtures.js";
import { response } from "./fixtures.js";

const apps: Awaited<ReturnType<typeof executionFixture>>[] = [];
async function make() {
  const app = await executionFixture();
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
});
it("automatically refreshes stale account usage and backs off failed connections", async () => {
  const { service, store } = await make();
  const account = store.get("account", "1", accountSchema);
  if (!account) throw new Error("Missing test account");
  store.put("account", "1", { ...account, verifiedAt: 0 });
  vi.spyOn(service.credentials, "token").mockResolvedValue(
    "owner-authorization",
  );
  const usage = vi
    .spyOn(service.context.github, "usageReport")
    .mockResolvedValue({ usedMinutes: 50, workerUsedMinutes: null });
  vi.spyOn(service.context.github, "repository").mockResolvedValue();
  const refresher = new CapacityRefresh(service);
  await refresher.run();
  expect(store.get("account", "1", accountSchema)).toMatchObject({
    usedMinutes: 50,
    repositoryVerified: true,
  });
  store.put("account", "1", { ...account, verifiedAt: 0 });
  await refresher.run();
  expect(usage).toHaveBeenCalledTimes(1);
  usage.mockRejectedValue(new Error("Provider unavailable"));
  await new CapacityRefresh(service).run();
  expect(store.get("account", "1", accountSchema)).toMatchObject({
    verifiedAt: null,
    usedMinutes: null,
  });
});
it("refreshes provider installations without ever provisioning compute and invalidates failures", async () => {
  const { service, store, providerId, fetcher } = await make();
  const provider = {
    projectId: providerId,
    name: "Cloud",
    installations: [{ id: "old", name: "owner" }],
    runner: "ubicloud-standard-4",
    priority: 2,
    rateMicros: 1000,
    budgetMicros: 50000,
    verifiedAt: 0,
  };
  store.put("provider", providerId, provider);
  store.setSecret(`ubicloud:${providerId}`, {
    token: "provider-authorization",
  });
  vi.mocked(fetcher).mockImplementation(async (input) =>
    String(input).endsWith("/github")
      ? response({ count: 1, items: [{ id: "new", name: "owner" }] })
      : response({ id: providerId, name: "Updated cloud" }),
  );
  await new CapacityRefresh(service).run();
  expect(store.get("provider", providerId, providerSchema)).toMatchObject({
    name: "Updated cloud",
    installations: [{ id: "new", name: "owner" }],
  });
  expect(
    vi
      .mocked(fetcher)
      .mock.calls.every(([, init]) => !init?.method || init.method === "GET"),
  ).toBe(true);
  store.put("provider", providerId, provider);
  vi.mocked(fetcher).mockRejectedValue(new Error("Unavailable"));
  await new CapacityRefresh(service).run();
  expect(store.get("provider", providerId, providerSchema)?.verifiedAt).toBe(0);
});
it("does not resurrect a disconnected provider during refresh", async () => {
  const { service, store, providerId, fetcher } = await make();
  store.put("provider", providerId, {
    projectId: providerId,
    name: "Cloud",
    installations: [],
    runner: "ubicloud-standard-4",
    priority: 2,
    rateMicros: 1000,
    budgetMicros: 50000,
    verifiedAt: 0,
  });
  store.setSecret(`ubicloud:${providerId}`, {
    token: "provider-authorization",
  });
  vi.mocked(fetcher).mockImplementation(async (input) => {
    if (String(input).endsWith("/github")) {
      store.remove("provider", providerId);
      return response({ count: 1, items: [{ id: "new", name: "owner" }] });
    }
    return response({ id: providerId, name: "Cloud" });
  });
  await new CapacityRefresh(service).run();
  expect(store.get("provider", providerId, providerSchema)).toBeNull();
});
