import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CircleHelp,
  Cloud,
  GitFork,
  LayoutDashboard,
  LogOut,
  Network,
  Settings2,
  ShieldCheck,
  Users,
  FlaskConical,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import {
  dashboardSchema,
  type Dashboard,
  type SessionView,
} from "../shared/contracts.js";
import { api, loadSession, number } from "./api.js";
import { Brand, Busy, Failure } from "./components.js";
import { Accounts } from "./Accounts.js";
import { Connections, TeamSettings } from "./Connections.js";
import { Routing, TestPlanner } from "./Routing.js";
import { Setup } from "./Setup.js";
import { Workloads, WorkerSetup } from "./Workloads.js";

const pages = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "workloads", label: "Workloads and runs", icon: GitFork },
  { id: "accounts", label: "Team accounts", icon: Users },
  { id: "routing", label: "Routing preview", icon: Network },
  { id: "tests", label: "Test planner", icon: FlaskConical },
  { id: "settings", label: "Connections", icon: Settings2 },
] as const;
type Page = (typeof pages)[number]["id"];

function Overview({
  data,
  session,
  navigate,
}: Readonly<{
  data: Dashboard;
  session: SessionView;
  navigate: (page: Page) => void;
}>) {
  const ready = data.candidates.filter(
    (candidate) =>
      candidate.kind === "github" &&
      !candidate.reason &&
      candidate.availableMinutes > 0,
  );
  const available = ready.reduce(
    (sum, candidate) => sum + candidate.availableMinutes,
    0,
  );
  return (
    <>
      <div className="hero">
        <div>
          <p className="eyebrow">A clearer view of your CI</p>
          <h1>
            Your team's capacity,
            <br />
            <em>working together.</em>
          </h1>
          <p>
            Bring your accounts into one view. Give each job a route that fits
            your limits.
          </p>
        </div>
        <div className="route-illustration" aria-hidden="true">
          <div>
            <GitFork size={20} />
            <span>Team accounts</span>
            <i />
          </div>
          <div className="route-line">
            <span />
            <span />
            <span />
          </div>
          <div className="route-target">
            <Brand />
          </div>
          <div className="route-line">
            <span />
            <span />
          </div>
          <div>
            <Cloud size={20} />
            <span>Fallback cloud</span>
            <i />
          </div>
        </div>
      </div>
      <div className="stats">
        <article>
          <span>Verified allowance remaining</span>
          <strong>
            {number(available)}
            <small> min</small>
          </strong>
          <p>Before pending run reservations</p>
        </article>
        <article>
          <span>Team accounts</span>
          <strong>{data.accounts.length.toString().padStart(2, "0")}</strong>
          <p>{ready.length} with verified available capacity</p>
        </article>
        <article>
          <span>Fallback providers</span>
          <strong>{data.providers.length.toString().padStart(2, "0")}</strong>
          <p>Rates and limits set by you</p>
        </article>
      </div>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Your shared capacity</p>
          <h2>Team accounts</h2>
        </div>
        <button className="text-button" onClick={() => navigate("settings")}>
          Connect your team
          <ArrowRight size={15} />
        </button>
      </div>
      <Accounts data={data} session={session} />
      <div className="overview-bottom">
        <section className="panel compact">
          <div className="section-heading">
            <h2>Give every job a plan</h2>
            <Network size={21} />
          </div>
          <p>
            Compare account priorities, memory needs and budgets before you run.
          </p>
          <button className="text-button" onClick={() => navigate("routing")}>
            Try a routing preview
            <ArrowRight size={15} />
          </button>
        </section>
        <section className="panel compact">
          <div className="section-heading">
            <h2>Your checks stay protected</h2>
            <ShieldCheck size={21} />
          </div>
          <p>
            BuildFerry publishes its own verified results. Your existing checks,
            branch rules and release approvals stay in place.
          </p>
        </section>
      </div>
      {data.activity.length > 0 && (
        <section className="activity">
          <p className="eyebrow">Recent activity</p>
          {data.activity.slice(0, 4).map((item) => (
            <div key={item.id}>
              <span className="activity-dot" />
              <span>{item.message}</span>
              <time dateTime={new Date(item.at).toISOString()}>
                {new Date(item.at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function DashboardView({ session }: Readonly<{ session: SessionView }>) {
  const [page, setPage] = useState<Page>("overview");
  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api("/api/dashboard", dashboardSchema),
    refetchInterval: 60_000,
    retry: false,
  });
  const logout = useMutation({
    mutationFn: () =>
      api("/api/logout", z.object({ ok: z.boolean() }), "POST", {}),
    onSuccess: () => globalThis.location.assign("/"),
  });
  const title = pages.find((item) => item.id === page)?.label ?? "Overview";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand-link" href="/" aria-label="BuildFerry overview">
          <Brand />
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">B</span>
          <div>
            Your workspace<small>Self-hosted instance</small>
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
            href="https://github.com/firwer/buildferry"
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
              {session.demo ? "Test fixtures" : "Your workspace"}
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
        <main className="main-content">
          {session.demo && (
            <div className="mode-notice">
              Test fixtures. No accounts are connected and no jobs will run.
            </div>
          )}
          <Failure error={query.error ?? logout.error} />
          {query.isPending && <Busy>Loading your workspace</Busy>}
          {query.data && (
            <>
              {page === "workloads" && <Workloads session={session} />}
              {page === "overview" && (
                <Overview
                  data={query.data}
                  session={session}
                  navigate={setPage}
                />
              )}
              {page === "accounts" && (
                <>
                  <div className="page-heading">
                    <p className="eyebrow">Shared by your team</p>
                    <h1>Team accounts</h1>
                    <p>
                      Owners control their contribution, reserve and priority.
                      Usage follows the current calendar month.
                    </p>
                  </div>
                  <Accounts data={query.data} session={session} />
                  <WorkerSetup data={query.data} session={session} />
                  <TeamSettings session={session} />
                </>
              )}
              {page === "routing" && (
                <>
                  <div className="page-heading">
                    <p className="eyebrow">Capacity with a clear order</p>
                    <h1>A route that fits your rules.</h1>
                    <p>
                      Lower priority numbers go first. Accounts on the same
                      level share the work.
                    </p>
                  </div>
                  <Routing />
                </>
              )}
              {page === "tests" && (
                <>
                  <div className="page-heading">
                    <p className="eyebrow">Plan for faster feedback</p>
                    <h1>More progress in parallel.</h1>
                    <p>
                      Compare independent test groups before changing your
                      pipeline.
                    </p>
                  </div>
                  <TestPlanner />
                </>
              )}
              {page === "settings" && (
                <>
                  <div className="page-heading">
                    <p className="eyebrow">Keep capacity connected</p>
                    <h1>Your accounts and providers.</h1>
                  </div>
                  <TeamSettings session={session} />
                  <Connections data={query.data} session={session} />
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>BuildFerry is self-hosted and open source.</span>
            <span>Required checks stay with your project.</span>
          </footer>
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
