import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executionFixture } from "./execution-fixtures.js";
import { response } from "./fixtures.js";
import { newAccount } from "../src/server/auth.js";
import { accountSchema } from "../src/shared/contracts.js";

const apps: Awaited<ReturnType<typeof executionFixture>>[] = [];
async function make() {
  const app = await executionFixture();
  apps.push(app);
  app.store.put("account", "2", newAccount(2, "member", "member"));
  app.store.setSecret("github-user:2", {
    access_token: "member-token",
    expires_at: null,
  });
  const user = vi
    .spyOn(app.service.context.github, "user")
    .mockResolvedValue({ id: 2, login: "member" });
  const create = () =>
    app.server.inject({
      method: "POST",
      url: "/api/accounts/2/repository",
      headers: app.headers,
      cookies: app.cookies,
      payload: {},
    });
  return { ...app, user, create };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
});
const metadata = (description: string) => ({
  id: 302,
  full_name: "member/buildferry-ci",
  private: true,
  archived: false,
  disabled: false,
  default_branch: "main",
  owner: { id: 2, login: "member" },
  description,
});

describe("automatic private worker repository creation", () => {
  it("uses the selected account's authorization and initializes a private repository", async () => {
    const app = await make();
    vi.mocked(app.fetcher)
      .mockResolvedValueOnce(response({}, 404))
      .mockImplementationOnce(async (_url, init) => {
        const body = z
          .object({
            name: z.string(),
            description: z.string(),
            private: z.boolean(),
            auto_init: z.boolean(),
          })
          .parse(JSON.parse(String(init?.body)));
        expect(body).toMatchObject({
          name: "buildferry-ci",
          private: true,
          auto_init: true,
        });
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer member-token",
        );
        expect(
          app.store.get(
            "worker-repository",
            "2:buildferry-ci",
            z.object({ marker: z.uuid() }),
          )?.marker,
        ).toBeTruthy();
        return response(metadata(body.description), 201);
      });
    const created = await app.create();
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      id: 2,
      repositoryVerified: true,
      settings: { workerRepository: "buildferry-ci" },
    });
    expect(app.user).toHaveBeenCalledWith("member-token");
    expect(created.body).not.toContain("member-token");
  });
  it("recovers a lost accepted response without creating another repository", async () => {
    const app = await make();
    let created: ReturnType<typeof metadata> | null = null;
    vi.mocked(app.fetcher).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        const body = z
          .object({ description: z.string() })
          .parse(JSON.parse(String(init.body)));
        created = metadata(body.description);
        throw new Error("Lost accepted response");
      }
      return created ? response(created) : response({}, 404);
    });
    expect((await app.create()).statusCode).toBe(502);
    expect((await app.create()).statusCode).toBe(200);
    expect(
      vi
        .mocked(app.fetcher)
        .mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });
  it("leaves an unrelated repository and the selected account unchanged", async () => {
    const app = await make();
    vi.mocked(app.fetcher).mockResolvedValue(
      response(metadata("Existing unrelated repository")),
    );
    expect((await app.create()).statusCode).toBe(409);
    expect(app.fetcher).toHaveBeenCalledTimes(1);
    expect(
      app.store.get("account", "2", accountSchema)?.settings.workerRepository,
    ).toBe("");
  });
  it("does not create anything using another account's credential", async () => {
    const app = await make();
    app.user.mockResolvedValue({ id: 3, login: "someone-else" });
    expect((await app.create()).statusCode).toBe(403);
    expect(app.fetcher).not.toHaveBeenCalled();
  });
  it("explains a missing creation permission without claiming setup succeeded", async () => {
    const app = await make();
    vi.mocked(app.fetcher)
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({}, 403));
    const denied = await app.create();
    expect(denied.statusCode).toBe(422);
    expect(denied.json().error).toContain("Repository creation");
    expect(
      app.store.get("account", "2", accountSchema)?.repositoryVerified,
    ).toBe(false);
  });
  it("rejects a returned public repository", async () => {
    const app = await make();
    vi.mocked(app.fetcher)
      .mockResolvedValueOnce(response({}, 404))
      .mockImplementationOnce(async (_url, init) => {
        const body = z
          .object({ description: z.string() })
          .parse(JSON.parse(String(init?.body)));
        return response({ ...metadata(body.description), private: false }, 201);
      });
    expect((await app.create()).statusCode).toBe(409);
  });
  it("keeps cross-account worker management restricted to the administrator", async () => {
    const app = await make();
    app.store.saveSession(
      "member-session",
      { githubId: 2, csrf: "member-csrf", setup: false },
      Date.now() + 60_000,
    );
    const denied = await app.server.inject({
      method: "POST",
      url: "/api/accounts/1/repository",
      headers: { ...app.headers, "x-buildferry-csrf": "member-csrf" },
      cookies: { bf_session: "member-session" },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(app.fetcher).not.toHaveBeenCalled();
  });
});
