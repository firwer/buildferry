import { afterEach, describe, expect, it, vi } from "vitest";
import { AppGitHub } from "../src/server/providers/app-github.js";
import { executionFixture } from "./execution-fixtures.js";
import { response } from "./fixtures.js";

const apps: Awaited<ReturnType<typeof executionFixture>>[] = [];
async function make() {
  const app = await executionFixture();
  apps.push(app);
  vi.spyOn(AppGitHub.prototype, "jwt").mockResolvedValue("app-identity");
  const access = () =>
    app.server.inject({
      url: "/api/native/accounts/1/access",
      headers: app.headers,
      cookies: app.cookies,
    });
  return { ...app, access };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
});
describe("actual GitHub App setup state", () => {
  it("distinguishes a signed-in account from an uninstalled App", async () => {
    const app = await make();
    vi.mocked(app.fetcher).mockResolvedValue(response({}, 404));
    const result = await app.access();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      state: "missing",
      message: expect.stringContaining("not installed for owner"),
    });
    expect(result.json().url).toMatch(
      /^https:\/\/github.com\/apps\/.+\/installations\/new$/,
    );
    expect(result.body).not.toContain("app-identity");
  });
  it("links to the account's specific permission approval rather than OAuth sign-in", async () => {
    const app = await make();
    vi.mocked(app.fetcher).mockResolvedValue(
      response({
        id: 401,
        account: { id: 1 },
        permissions: { contents: "read" },
        suspended_at: null,
      }),
    );
    expect((await app.access()).json()).toMatchObject({
      state: "approval",
      url: "https://github.com/settings/installations/401",
    });
  });
  it("requires all worker permissions and an active installation before reporting ready", async () => {
    const app = await make();
    const installation = {
      id: 401,
      account: { id: 1 },
      permissions: {
        repository_creation: "write",
        contents: "write",
        workflows: "write",
        actions: "write",
      },
      suspended_at: null as string | null,
    };
    vi.mocked(app.fetcher).mockImplementation(async () =>
      response(installation),
    );
    expect((await app.access()).json().state).toBe("ready");
    installation.suspended_at = "2026-10-18T00:00:00Z";
    expect((await app.access()).json().state).toBe("approval");
    installation.account.id = 999;
    expect((await app.access()).statusCode).toBe(409);
  });
  it("does not inspect an account installation without authentication", async () => {
    const app = await make();
    expect(
      (await app.server.inject("/api/native/accounts/1/access")).statusCode,
    ).toBe(401);
    expect(app.fetcher).not.toHaveBeenCalled();
  });
});
