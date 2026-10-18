import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SubmitEvent } from "react";
import {
  executionDashboardSchema,
  jobSchema,
  projectSchema,
  workerSchema,
  type Project,
} from "../shared/execution.js";
import type { Dashboard, SessionView } from "../shared/contracts.js";
import { api, money, number } from "./api.js";
import { Busy, Dialog, Empty, External, Failure } from "./components.js";

const executionQuery = {
  queryKey: ["execution"],
  queryFn: () => api("/api/execution", executionDashboardSchema),
  refetchInterval: 5000,
  retry: false,
} as const;

function WorkloadForm({
  project,
  onClose,
}: Readonly<{ project?: Project; onClose: () => void }>) {
  const client = useQueryClient();
  const [repository, setRepository] = useState(project?.repository ?? "");
  const [name, setName] = useState(project?.recipe.name ?? "");
  const [directory, setDirectory] = useState(project?.recipe.directory ?? ".");
  const [commands, setCommands] = useState(
    project?.recipe.commands.join("\n") ?? "",
  );
  const [minutes, setMinutes] = useState(project?.recipe.maxMinutes ?? 20);
  const [memory, setMemory] = useState(project?.recipe.memoryGiB ?? 8);
  const [spend, setSpend] = useState(
    (project?.recipe.maxCostMicros ?? 0) / 1_000_000,
  );
  const [onPush, setOnPush] = useState(project?.onPush ?? false);
  const [enabled, setEnabled] = useState(project?.enabled ?? true);
  const save = useMutation({
    mutationFn: () => {
      const recipe = {
        name,
        directory,
        commands: commands.split("\n").filter((command) => command.trim()),
        maxMinutes: minutes,
        memoryGiB: memory,
        maxCostMicros: Math.round(spend * 1_000_000),
      };
      return project
        ? api(`/api/projects/${project.id}`, projectSchema, "PUT", {
            recipe,
            enabled,
            onPush,
          })
        : api("/api/projects", projectSchema, "POST", {
            repository,
            recipe,
            onPush,
          });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["execution"] });
      onClose();
    },
  });
  function submit(event: SubmitEvent) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <Dialog
      title={project ? "Edit workload" : "Connect a workload"}
      onClose={onClose}
    >
      <p className="panel-intro">
        Install your GitHub App on the source repository first. Add independent
        builds or test groups as separate workloads so they can run together.
      </p>
      <form className="form-grid" onSubmit={submit}>
        <label className="full">
          <span>Source repository</span>
          <input
            required
            disabled={Boolean(project)}
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="owner/repository"
          />
        </label>
        <label>
          <span>Workload name</span>
          <input
            required
            maxLength={70}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>Folder in repository</span>
          <input
            required
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
          />
        </label>
        <label className="full">
          <span>Approved commands, one per line</span>
          <textarea
            required
            rows={6}
            value={commands}
            onChange={(event) => setCommands(event.target.value)}
            spellCheck={false}
          />
          <small>
            Include installation and every check this workload must run. Each
            line runs in its own shell.
          </small>
        </label>
        <label>
          <span>Maximum minutes</span>
          <input
            type="number"
            min={2}
            max={180}
            required
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
          />
        </label>
        <label>
          <span>Memory needed (GB)</span>
          <input
            type="number"
            min={1}
            max={64}
            required
            value={memory}
            onChange={(event) => setMemory(Number(event.target.value))}
          />
        </label>
        <label>
          <span>Paid limit per run ($)</span>
          <input
            type="number"
            min={0}
            max={1000}
            step="0.01"
            required
            value={spend}
            onChange={(event) => setSpend(Number(event.target.value))}
          />
          <small>Zero allows free GitHub capacity only.</small>
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={onPush}
            onChange={(event) => setOnPush(event.target.checked)}
          />
          <span>Run on default branch updates</span>
        </label>
        {project && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>Workload enabled</span>
          </label>
        )}
        <div className="full">
          <Failure error={save.error} />
          <button className="button primary" disabled={save.isPending}>
            {save.isPending ? <Busy>Saving workload</Busy> : "Save workload"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function WorkerSetup({
  data,
  session,
}: Readonly<{ data: Dashboard; session: SessionView }>) {
  const client = useQueryClient();
  const query = useQuery(executionQuery);
  const [selected, setSelected] = useState<string[] | null>(null);
  const own = data.accounts.find((account) => account.id === session.user?.id);
  const worker = query.data?.workers.find(
    (value) => value.accountId === own?.id,
  );
  const approved = selected ?? worker?.allowedProjects ?? [];
  const install = useMutation({
    mutationFn: () =>
      api("/api/workers", workerSchema, "POST", {
        accountId: own?.id,
        allowedProjects: approved,
      }),
    onSuccess: async () => {
      setSelected(null);
      await client.invalidateQueries({ queryKey: ["execution"] });
    },
  });
  const installLabel = worker
    ? "Save project approvals"
    : "Install worker and approve projects";
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Your account, your choice</p>
          <h2>Your worker</h2>
        </div>
        <span className="status">{worker ? "Installed" : "Setup needed"}</span>
      </div>
      <p className="panel-intro">
        Create a new private CI repository with a README, select it in your
        account settings, then install the GitHub App on it. Existing
        repositories with CI history cannot be overwritten.
      </p>
      <p>
        {own?.settings.workerRepository
          ? `${own.login}/${own.settings.workerRepository}`
          : "Choose your private CI repository in account settings first."}
      </p>
      {session.app && (
        <p>
          <External href={session.app.installUrl}>
            Install or manage GitHub App access
          </External>
        </p>
      )}
      <fieldset className="consent-list">
        <legend>Projects you approve for your worker</legend>
        {query.data?.projects.map((project) => (
          <label className="checkbox-field" key={project.id}>
            <input
              type="checkbox"
              checked={approved.includes(project.id)}
              onChange={(event) =>
                setSelected(
                  event.target.checked
                    ? [...approved, project.id]
                    : approved.filter((id) => id !== project.id),
                )
              }
            />
            <span>
              {project.repository} / {project.recipe.name}
            </span>
          </label>
        ))}
        {query.data?.projects.length === 0 && (
          <p>Connect a workload before approving it here.</p>
        )}
      </fieldset>
      <button
        className="button primary"
        disabled={
          session.demo ||
          !own?.settings.workerRepository ||
          install.isPending ||
          !query.data
        }
        onClick={() => install.mutate()}
      >
        {install.isPending ? <Busy>Installing your worker</Busy> : installLabel}
      </button>
      <Failure error={query.error ?? install.error} />
    </section>
  );
}

function RunForm({
  project,
  onClose,
}: Readonly<{ project: Project; onClose: () => void }>) {
  const client = useQueryClient();
  const [sha, setSha] = useState("");
  const [route, setRoute] = useState("auto");
  const run = useMutation({
    mutationFn: () =>
      api("/api/jobs", jobSchema, "POST", {
        projectId: project.id,
        ...(sha ? { sha } : {}),
        route,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["execution"] });
      onClose();
    },
  });
  return (
    <Dialog title={`Run ${project.recipe.name}`} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          run.mutate();
        }}
      >
        <p className="full">
          {project.repository}. Leave the revision blank to use the latest
          default branch commit.
        </p>
        <label className="full">
          <span>Commit revision (optional)</span>
          <input
            value={sha}
            pattern="[a-f0-9]{40}"
            onChange={(event) => setSha(event.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="full">
          <span>Capacity</span>
          <select
            value={route}
            onChange={(event) => setRoute(event.target.value)}
          >
            <option value="auto">Follow configured priorities</option>
            <option value="github">Free GitHub minutes only</option>
            <option value="ubicloud">Ubicloud benchmark</option>
          </select>
        </label>
        <p className="fine-print full">
          Benchmarks still respect your paid limits. Compare the same revision
          and commands across providers; results show actual queue and command
          times.
        </p>
        <div className="full">
          <Failure error={run.error} />
          <button className="button primary" disabled={run.isPending}>
            {run.isPending ? <Busy>Queuing workload</Busy> : "Queue run"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function Workloads({ session }: Readonly<{ session: SessionView }>) {
  const client = useQueryClient();
  const query = useQuery(executionQuery);
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [running, setRunning] = useState<Project | null>(null);
  const canEdit = session.user?.role === "owner" && !session.demo;
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api(`/api/jobs/${id}/cancel`, jobSchema, "POST", {}),
    onSettled: () => client.invalidateQueries({ queryKey: ["execution"] }),
  });
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">Real builds, shared capacity</p>
        <h1>Workloads and runs</h1>
        <p>
          Independent workloads run in parallel across approved team accounts.
          Existing project checks and release approvals stay in place.
        </p>
      </div>
      <Failure error={query.error ?? cancel.error} />
      {query.isPending && <Busy>Loading workloads</Busy>}
      <section className="panel">
        <div className="section-heading">
          <h2>Approved workloads</h2>
          {canEdit && (
            <button
              className="button primary"
              onClick={() => setEditing("new")}
            >
              Connect workload
            </button>
          )}
        </div>
        {query.data?.projects.length === 0 && (
          <Empty title="Connect your first workload">
            Add your real repository and the build or test commands you want to
            run.
          </Empty>
        )}
        <div className="workload-list">
          {query.data?.projects.map((project) => (
            <article className="workload-row" key={project.id}>
              <div>
                <h3>{project.recipe.name}</h3>
                <p>{project.repository}</p>
                <small>
                  {project.enabled ? "Enabled" : "Paused"}
                  {project.onPush
                    ? " / Runs on default branch updates"
                    : " / Manual runs"}
                </small>
              </div>
              <div className="row-actions">
                {canEdit && (
                  <>
                    <button
                      className="button secondary"
                      onClick={() => setEditing(project)}
                    >
                      Edit {project.recipe.name}
                    </button>
                    <button
                      className="button primary"
                      disabled={!project.enabled}
                      onClick={() => setRunning(project)}
                    >
                      Run {project.recipe.name}
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Run history</h2>
          <span>Updates every 5 seconds</span>
        </div>
        {query.data?.jobs.length === 0 && (
          <Empty title="No runs yet">
            Queue a workload after its worker owner approves the project. Only
            actual runs appear here.
          </Empty>
        )}
        <div className="run-list">
          {query.data?.jobs.map((job) => (
            <article className="run-card" key={job.id}>
              <div className="section-heading">
                <div>
                  <h3>{job.recipe.name}</h3>
                  <p>
                    {
                      query.data.projects.find(
                        (project) => project.id === job.projectId,
                      )?.repository
                    }{" "}
                    / {job.sourceSha.slice(0, 12)}
                  </p>
                </div>
                <span className="status">{job.state}</span>
              </div>
              <p>{job.message}</p>
              <div className="run-metrics">
                <span>{job.worker?.repository ?? "No worker assigned"}</span>
                <span>{job.providerId ? "Ubicloud" : "GitHub"}</span>
                {job.actualMinutes !== null && (
                  <span>{number(job.actualMinutes)} min billed</span>
                )}
                {job.actualMicros !== null && (
                  <span>{money(job.actualMicros)}</span>
                )}
                {job.queueSeconds !== null && (
                  <span>Queue {number(job.queueSeconds)}s</span>
                )}
                {job.commandSeconds !== null && (
                  <span>Commands {number(job.commandSeconds)}s</span>
                )}
              </div>
              <div className="row-actions">
                {job.url && <External href={job.url}>Open worker log</External>}
                {canEdit &&
                  ["queued", "dispatching", "running"].includes(job.state) && (
                    <button
                      className="text-button danger"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(job.id)}
                    >
                      Cancel run
                    </button>
                  )}
              </div>
            </article>
          ))}
        </div>
      </section>
      {editing && (
        <WorkloadForm
          project={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {running && (
        <RunForm project={running} onClose={() => setRunning(null)} />
      )}
    </>
  );
}
