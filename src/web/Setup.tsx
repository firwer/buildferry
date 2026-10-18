import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitFork, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";
import { z } from "zod";
import type { SessionView } from "../shared/contracts.js";
import { api } from "./api.js";
import { Brand, Busy, Failure } from "./components.js";
import { useAccountAccess } from "./native-data.js";

const manifestResponse = z.object({
  url: z.url(),
  manifest: z.record(z.string(), z.unknown()),
});

export function Setup({ session }: Readonly<{ session: SessionView }>) {
  const access = useAccountAccess(
    session.stage === "connected" ? session.user?.id : undefined,
  );
  const client = useQueryClient();
  const [code, setCode] = useState("");
  const [appName, setAppName] = useState("BuildFerry Team");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () =>
      api("/api/login", z.object({ ok: z.boolean() }), "POST", {
        username,
        password,
      }),
    onSuccess: async () => {
      setPassword("");
      await client.invalidateQueries({ queryKey: ["session"] });
    },
  });
  const logout = useMutation({
    mutationFn: () =>
      api("/api/logout", z.object({ ok: z.boolean() }), "POST", {}),
    onSuccess: () => client.invalidateQueries({ queryKey: ["session"] }),
  });
  const claim = useMutation({
    mutationFn: () =>
      api("/api/claim", z.object({ ok: z.boolean() }), "POST", { code }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["session"] }),
  });
  const manifest = useMutation({
    mutationFn: () =>
      api("/api/setup/manifest", manifestResponse, "POST", { name: appName }),
  });
  const invite = new URLSearchParams(globalThis.location.search).get("invite");
  const loginUrl = invite
    ? `/auth/github?invite=${encodeURIComponent(invite)}`
    : "/auth/github";
  function submit(event: SubmitEvent) {
    event.preventDefault();
    claim.mutate();
  }
  return (
    <main className="welcome">
      <Brand />
      <div className="welcome-grid">
        <section className="welcome-story">
          <p className="eyebrow">Your capacity. Your rules.</p>
          <h1>
            Give your builds
            <br />a better route.
          </h1>
          <p>
            Bring your team's accounts and runners together. Keep control of the
            minutes, the spend, and the work that matters.
          </p>
          <div className="welcome-note">
            <ShieldCheck size={20} />
            <span>
              Your required checks and release approvals stay with your project.
            </span>
          </div>
        </section>
        <section className="setup-card" aria-label="Connect BuildFerry">
          {session.stage === "claim" && (
            <>
              <span className="step">01 / Welcome aboard</span>
              <h2>Claim your instance</h2>
              <p>
                Enter the one-use setup code from your server's startup logs.
              </p>
              <form onSubmit={submit}>
                <label htmlFor="claim-code">
                  <span>Setup code</span>
                </label>
                <input
                  id="claim-code"
                  type="password"
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="off"
                />
                <Failure error={claim.error} />
                <button className="button primary" disabled={claim.isPending}>
                  {claim.isPending ? (
                    <Busy>Checking code</Busy>
                  ) : (
                    "Continue setup"
                  )}
                </button>
              </form>
            </>
          )}
          {session.stage === "setup" && !session.app && (
            <>
              <span className="step">02 / Connect GitHub</span>
              <h2>Make it your own</h2>
              <p>
                Create a GitHub App owned by your team. BuildFerry fills in the
                connection settings.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  manifest.mutate();
                }}
              >
                <label htmlFor="app-name">
                  <span>GitHub App name</span>
                </label>
                <input
                  id="app-name"
                  required
                  minLength={3}
                  maxLength={34}
                  value={appName}
                  onChange={(event) => setAppName(event.target.value)}
                />
                <Failure error={manifest.error} />
                <button
                  className="button primary"
                  disabled={manifest.isPending}
                >
                  {manifest.isPending ? (
                    <Busy>Preparing setup</Busy>
                  ) : (
                    "Prepare GitHub connection"
                  )}
                </button>
              </form>
              {manifest.data && (
                <form
                  method="post"
                  action={manifest.data.url}
                  className="next-step"
                >
                  <input
                    type="hidden"
                    name="manifest"
                    value={JSON.stringify(manifest.data.manifest)}
                  />
                  <button className="button primary">
                    <GitFork size={17} />
                    Continue on GitHub
                  </button>
                </form>
              )}
              <p className="fine-print">
                A public HTTPS address is required to finish the GitHub
                connection.
              </p>
            </>
          )}
          {session.stage === "connected" && (
            <>
              <span className="step">Account connected</span>
              <h2>
                {access.data?.state === "ready"
                  ? "You are all set"
                  : "Finish GitHub setup"}
              </h2>
              <p>
                {access.data?.message ??
                  "Your sign-in is complete. Checking GitHub App access for runner setup."}
              </p>
              {access.data && access.data.state !== "ready" && (
                <a className="button primary" href={access.data.url}>
                  Open GitHub App settings
                </a>
              )}
              <button
                className="button secondary"
                disabled={access.isFetching}
                onClick={() => access.refetch()}
              >
                Check access again
              </button>
              <Failure error={access.error} />
              <button
                className="button secondary"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
              >
                Return to sign in
              </button>
              <Failure error={logout.error} />
            </>
          )}
          {session.stage === "login" && session.passwordLogin && !invite && (
            <>
              <span className="step">Your company workspace</span>
              <h2>Sign in to BuildFerry</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  login.mutate();
                }}
              >
                <label htmlFor="admin-username">
                  <span>Username</span>
                </label>
                <input
                  id="admin-username"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <label htmlFor="admin-password">
                  <span>Password</span>
                </label>
                <input
                  id="admin-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <Failure error={login.error} />
                <button className="button primary" disabled={login.isPending}>
                  {login.isPending ? <Busy>Signing in</Busy> : "Sign in"}
                </button>
              </form>
            </>
          )}
          {((session.stage === "login" && (!session.passwordLogin || invite)) ||
            (session.stage === "setup" && session.app)) && (
            <>
              <span className="step">Your team workspace</span>
              <h2>{invite ? "Join your team" : "Welcome to BuildFerry"}</h2>
              <p>
                {session.stage === "setup"
                  ? "Sign in with the account that registered your GitHub App to finish setup."
                  : "Connect your GitHub account so your company can use its CI capacity. Your administrator manages limits and worker setup."}
              </p>
              <a className="button primary" href={loginUrl}>
                <GitFork size={18} />
                Continue with GitHub
              </a>
              <p className="fine-print">
                New team members need an invitation from the instance owner.
              </p>
            </>
          )}
        </section>
      </div>
      <footer className="welcome-footer">
        Self-hosted. Built for your team.{" "}
        <span>Shared CI / Your infrastructure</span>
      </footer>
    </main>
  );
}
