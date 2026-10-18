import { scryptSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, response, sampleApp } from "./fixtures.js";
import { accountSchema } from "../src/shared/contracts.js";

const password = "fixture-admin-password";
const salt = Buffer.alloc(32, 7);
const admin = {
  username: "admin",
  salt,
  passwordHash: scryptSync(password, salt, 64),
};
const apps: Awaited<ReturnType<typeof fixture>>[] = [];
async function make(signedIn = true) {
  const app = await fixture({ signedIn, config: { admin } });
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.server.close()));
  vi.restoreAllMocks();
});
async function signIn(
  app: Awaited<ReturnType<typeof fixture>>,
  supplied = password,
) {
  return app.server.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: app.config.publicUrl },
    payload: { username: "admin", password: supplied },
  });
}

describe("environment administrator sign-in", () => {
  it("starts setup through the password without a claim-code bypass", async () => {
    const app = await make(false);
    expect((await app.server.inject("/api/session")).json()).toMatchObject({
      stage: "login",
      passwordLogin: true,
    });
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/claim",
          headers: { origin: app.config.publicUrl },
          payload: { code: "fixture-claim-code" },
        })
      ).statusCode,
    ).toBe(409);
    const logged = await signIn(app);
    expect(logged.statusCode).toBe(200);
    const cookies = {
      bf_session:
        logged.cookies.find((cookie) => cookie.name === "bf_session")?.value ??
        "",
    };
    expect(
      (await app.server.inject({ url: "/api/session", cookies })).json().stage,
    ).toBe("setup");
    expect(app.claimCode).toBe("");
  });
  it("issues a secure administrator session, protects writes and logs out", async () => {
    const app = await make();
    const logged = await signIn(app);
    expect(logged.statusCode).toBe(200);
    expect(String(logged.headers["set-cookie"])).toMatch(/HttpOnly/);
    expect(String(logged.headers["set-cookie"])).toMatch(/Secure/);
    const token =
      logged.cookies.find((cookie) => cookie.name === "bf_session")?.value ??
      "";
    const cookies = { bf_session: token };
    const session = await app.server.inject({ url: "/api/session", cookies });
    expect(session.json()).toMatchObject({
      stage: "dashboard",
      user: { login: "admin", role: "owner" },
    });
    expect(session.body).not.toContain(password);
    expect(session.body).not.toContain(admin.passwordHash.toString("hex"));
    const headers = {
      origin: app.config.publicUrl,
      "x-buildferry-csrf": session.json<{ csrf: string }>().csrf,
    };
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/invitations",
          cookies,
          headers: { origin: app.config.publicUrl },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/invitations",
          cookies,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/logout",
          cookies,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(app.store.session(token)).toBeNull();
  });
  it("rejects cross-origin login and throttles failed attempts", async () => {
    const app = await make();
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/login",
          headers: { origin: "https://attacker.example" },
          payload: { username: "admin", password },
        })
      ).statusCode,
    ).toBe(403);
    for (let attempt = 0; attempt < 4; attempt++)
      expect((await signIn(app, "wrong-password")).statusCode).toBe(401);
    expect((await signIn(app, "wrong-password")).statusCode).toBe(429);
  });
  it("does not let a GitHub session bypass password administration", async () => {
    const app = await make();
    expect(
      (
        await app.server.inject({ url: "/api/session", cookies: app.cookies })
      ).json(),
    ).toMatchObject({ stage: "connected", user: { role: "member" } });
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/invitations",
          cookies: app.cookies,
          headers: app.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it("invalidates existing administrator sessions when credentials change", async () => {
    const app = await make();
    const logged = await signIn(app);
    const cookies = {
      bf_session:
        logged.cookies.find((cookie) => cookie.name === "bf_session")?.value ??
        "",
    };
    Object.assign(app.config, {
      admin: {
        ...admin,
        passwordHash: scryptSync("replacement-password", salt, 64),
      },
    });
    expect(
      (await app.server.inject({ url: "/api/dashboard", cookies })).statusCode,
    ).toBe(401);
  });
  it("preserves the administrator session while connecting another GitHub owner", async () => {
    const app = await make();
    app.store.setSecret("github-app", sampleApp);
    vi.mocked(app.fetcher)
      .mockResolvedValueOnce(response({ access_token: "member-token" }))
      .mockResolvedValueOnce(response({ id: 2, login: "member" }));
    const logged = await signIn(app);
    const cookies = {
      bf_session:
        logged.cookies.find((cookie) => cookie.name === "bf_session")?.value ??
        "",
    };
    const current = (
      await app.server.inject({ url: "/api/session", cookies })
    ).json<{ csrf: string }>();
    const invitation = (
      await app.server.inject({
        method: "POST",
        url: "/api/invitations",
        cookies,
        headers: {
          origin: app.config.publicUrl,
          "x-buildferry-csrf": current.csrf,
        },
        payload: {},
      })
    ).json<{ url: string }>();
    const invite = new URL(invitation.url).searchParams.get("invite");
    const start = await app.server.inject({
      url: `/auth/github?invite=${invite}`,
      cookies,
    });
    const state = new URL(String(start.headers.location)).searchParams.get(
      "state",
    );
    const completed = await app.server.inject({
      url: `/auth/callback?code=code&state=${state}`,
      cookies: { ...cookies, bf_oauth: state ?? "" },
    });
    expect(completed.statusCode).toBe(302);
    const updatedCookies = {
      bf_session:
        completed.cookies.find((cookie) => cookie.name === "bf_session")
          ?.value ?? "",
    };
    expect(
      (
        await app.server.inject({
          url: "/api/session",
          cookies: updatedCookies,
        })
      ).json(),
    ).toMatchObject({
      stage: "dashboard",
      user: { id: 1, login: "admin", role: "owner" },
    });
    expect(app.store.get("account", "2", accountSchema)?.login).toBe("member");
  });
});
