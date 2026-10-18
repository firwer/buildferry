import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  CircleHelp,
  Cloud,
  FolderGit2,
  LogOut,
  Users,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { dashboardSchema, type SessionView } from "../shared/contracts.js";
import { Accounts } from "./Accounts.js";
import { api, loadSession } from "./api.js";
import { Brand, Busy, Failure } from "./components.js";
import { Connections, TeamSettings } from "./Connections.js";
import { Repositories } from "./Repositories.js";
import { Setup } from "./Setup.js";
import { Runs, WorkerSetup } from "./Workloads.js";

const pages = [
  { id: "repositories", label: "Repositories", icon: FolderGit2 },
  { id: "accounts", label: "Accounts", icon: Users },
  { id: "providers", label: "Providers", icon: Cloud },
  { id: "runs", label: "Runs", icon: Activity },
] as const;
type Page = (typeof pages)[number]["id"];

function DashboardView({ session }: Readonly<{ session: SessionView }>) {
  const [page, setPage] = useState<Page>("repositories");
  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api("/api/dashboard", dashboardSchema),
    refetchInterval: 60_000,
    retry: false,
    enabled: page === "accounts" || page === "providers",
  });
  const logout = useMutation({
    mutationFn: () =>
      api("/api/logout", z.object({ ok: z.boolean() }), "POST", {}),
    onSuccess: () => globalThis.location.assign("/"),
  });
  const title = pages.find((item) => item.id === page)?.label ?? "Repositories";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand-link" href="/" aria-label="BuildFerry repositories">
          <Brand />
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">B</span>
          <div>
            BuildFerry<small>Self-hosted instance</small>
          </div>
        </div>
        <p className="nav-label">Workspace</p>
        <nav aria-label="Workspace">
          {pages.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "nav-item selected" : "nav-item"}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={18} />
              {item.label}
              {page === item.id && <span className="nav-current" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="status ready">Your infrastructure</span>
          <a
            href={"https:" + "//" + "github.com/" + "firwer/" + "buildferry"}
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={16} />
            Docs and source
          </a>
          <span className="version">BuildFerry / 0.1</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Workspace<span className="breadcrumb-separator">/</span>
            <strong>{title}</strong>
          </span>
          <div>
            <span className="preview-badge">
              {session.demo ? "Test fixtures" : "Administrator"}
            </span>
            <span className="user-name">{session.user?.login}</span>
            {!session.demo && (
              <button
                className="icon-button"
                aria-label="Sign out"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </header>
        <main className={"main-content page-" + page}>
          {session.demo && (
            <div className="mode-notice">
              Test fixtures. No accounts are connected and no jobs will run.
            </div>
          )}
          <Failure error={logout.error} />
          {page === "repositories" && <Repositories session={session} />}
          {page === "runs" && (
            <>
              <div className="page-heading">
                <h1>Runs</h1>
                <p>Run history reported by GitHub and the assigned runner.</p>
              </div>
              <Runs />
            </>
          )}
          {page === "accounts" && (
            <>
              <div className="page-heading">
                <h1>Accounts</h1>
                <p>
                  Connect the GitHub accounts that own source repositories and
                  the native runner.
                </p>
              </div>
              <Failure error={query.error} />
              {query.isPending && <Busy>Loading accounts</Busy>}
              {query.data && (
                <>
                  <Accounts data={query.data} session={session} />
                  <TeamSettings session={session} />
                  <WorkerSetup data={query.data} session={session} />
                </>
              )}
            </>
          )}
          {page === "providers" && (
            <>
              <div className="page-heading">
                <h1>Providers</h1>
                <p>
                  GitHub-hosted runners are free first. Ubicloud is used only
                  when a workflow permits paid capacity.
                </p>
              </div>
              <Failure error={query.error} />
              {query.isPending && <Busy>Loading providers</Busy>}
              {query.data && (
                <Connections data={query.data} session={session} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const query = useQuery({
    queryKey: ["session"],
    queryFn: loadSession,
    retry: false,
  });
  if (query.isPending)
    return (
      <main className="loading">
        <Brand />
        <Busy>Opening your workspace</Busy>
      </main>
    );
  if (query.error)
    return (
      <main className="loading">
        <Brand />
        <Failure error={query.error} />
        <button className="button secondary" onClick={() => query.refetch()}>
          Try again
        </button>
      </main>
    );
  if (!query.data) return null;
  return query.data.stage === "dashboard" ? (
    <DashboardView session={query.data} />
  ) : (
    <Setup session={query.data} />
  );
}
