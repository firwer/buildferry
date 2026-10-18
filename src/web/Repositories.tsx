import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, LockKeyhole, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { SessionView } from "../shared/contracts.js";
import {
  nativeDashboardSchema,
  type NativeRepository,
} from "../shared/native.js";
import { api } from "./api.js";
import { Busy, Empty, External, Failure } from "./components.js";
import { nativeQueryKey, useNativeDashboard } from "./native-data.js";
import { WorkflowDetail } from "./WorkflowDetail.js";

const dateLabel = (value: number) =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);

function RepositoryPicker({
  repositories,
  selectedId,
  onSelect,
}: Readonly<{
  repositories: NativeRepository[];
  selectedId: number | null;
  onSelect: (repository: NativeRepository) => void;
}>) {
  return (
    <>
      <label className="mobile-picker">
        <span>Repository</span>
        <select
          value={selectedId ?? ""}
          onChange={(event) => {
            const next = repositories.find(
              (item) => item.id === Number(event.target.value),
            );
            if (next) onSelect(next);
          }}
        >
          {repositories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.repository}
            </option>
          ))}
        </select>
      </label>
      <div className="picker-list" aria-label="Repositories">
        {repositories.map((repository) => (
          <button
            type="button"
            className={
              selectedId === repository.id
                ? "picker-item selected"
                : "picker-item"
            }
            key={repository.id}
            aria-pressed={selectedId === repository.id}
            aria-label={"Open " + repository.repository}
            onClick={() => onSelect(repository)}
          >
            <span className="picker-title">
              <strong>{repository.repository}</strong>
              {repository.private && (
                <LockKeyhole size={13} aria-label="Private repository" />
              )}
            </span>
            <span>
              {repository.workflows.length} workflow
              {repository.workflows.length === 1 ? "" : "s"} ·{" "}
              {repository.defaultBranch}
            </span>
            <small>Head {repository.headSha.slice(0, 10)}</small>
            {repository.error && (
              <span className="status quiet">Needs attention</span>
            )}
          </button>
        ))}
      </div>
    </>
  );
}

function WorkflowPicker({
  repository,
  selectedId,
  onSelect,
}: Readonly<{
  repository: NativeRepository;
  selectedId: number | null;
  onSelect: (id: number) => void;
}>) {
  return (
    <>
      <label className="mobile-picker">
        <span>Workflow</span>
        <select
          value={selectedId ?? ""}
          onChange={(event) => onSelect(Number(event.target.value))}
        >
          {repository.workflows.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <div className="picker-list" aria-label="Workflows">
        {repository.workflows.map((workflow) => (
          <button
            type="button"
            className={
              selectedId === workflow.id
                ? "picker-item selected"
                : "picker-item"
            }
            key={workflow.id}
            aria-pressed={selectedId === workflow.id}
            aria-label={"Open " + workflow.name}
            onClick={() => onSelect(workflow.id)}
          >
            <span className="picker-title">
              <strong>{workflow.name}</strong>
              <span
                className={workflow.enabled ? "status ready" : "status quiet"}
              >
                {workflow.enabled ? "Enabled" : "Paused"}
              </span>
            </span>
            <span>{workflow.path}</span>
            <small>
              {workflow.jobs.length} job{workflow.jobs.length === 1 ? "" : "s"}{" "}
              · Head {workflow.sha.slice(0, 10)}
            </small>
            {workflow.error && <span className="status quiet">Read error</span>}
          </button>
        ))}
      </div>
    </>
  );
}

export function Repositories({ session }: Readonly<{ session: SessionView }>) {
  const client = useQueryClient();
  const query = useNativeDashboard();
  const [repositoryId, setRepositoryId] = useState<number | null>(null);
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  const refresh = useMutation({
    mutationFn: () =>
      api("/api/native/refresh", nativeDashboardSchema, "POST", {}),
    onSuccess: (data) => client.setQueryData(nativeQueryKey, data),
  });
  const repositories = query.data?.repositories ?? [];
  const repository =
    repositories.find((item) => item.id === repositoryId) ??
    repositories[0] ??
    null;
  const workflow =
    repository?.workflows.find((item) => item.id === workflowId) ??
    repository?.workflows.find(
      (item) => item.path === ".github/workflows/ci.yml",
    ) ??
    repository?.workflows[0] ??
    null;
  return (
    <>
      <div className="page-heading with-action">
        <div>
          <h1>Repositories</h1>
          <p>Repositories and workflows discovered through your GitHub App.</p>
        </div>
        <button
          className="button primary"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? (
            <Busy>Refreshing</Busy>
          ) : (
            <>
              <RefreshCw size={15} />
              Refresh from GitHub
            </>
          )}
        </button>
      </div>
      <Failure error={refresh.error ?? query.error} />
      {query.isPending && <Busy>Loading repositories</Busy>}
      {query.error && (
        <button className="button secondary" onClick={() => query.refetch()}>
          Try again
        </button>
      )}
      {query.data && repositories.length === 0 && (
        <Empty title="No repositories connected">
          Install the GitHub App on a repository, then refresh this list.
          {session.app && (
            <>
              {" "}
              <External href={session.app.installUrl}>
                Manage GitHub App access
              </External>
            </>
          )}
        </Empty>
      )}
      {repository && (
        <div className="repository-browser">
          <section
            className="browser-rail"
            aria-labelledby="repository-heading"
          >
            <div className="rail-heading">
              <h2 id="repository-heading">Repositories</h2>
              <span>{repositories.length}</span>
            </div>
            <RepositoryPicker
              repositories={repositories}
              selectedId={repository.id}
              onSelect={(next) => {
                setRepositoryId(next.id);
                setWorkflowId(null);
              }}
            />
          </section>
          <section className="browser-rail" aria-labelledby="workflow-heading">
            <div className="rail-heading">
              <h2 id="workflow-heading">Workflows</h2>
              <span>{repository.workflows.length}</span>
            </div>
            {repository.error && (
              <p className="inline-note" role="alert">
                {repository.error}
              </p>
            )}
            {repository.workflows.length ? (
              <WorkflowPicker
                repository={repository}
                selectedId={workflow?.id ?? null}
                onSelect={setWorkflowId}
              />
            ) : (
              <p className="empty-inline">No workflows found.</p>
            )}
          </section>
          <section className="browser-detail" aria-label="Workflow details">
            {workflow ? (
              <WorkflowDetail
                key={repository.id + ":" + workflow.id}
                repository={repository}
                workflow={workflow}
              />
            ) : (
              <div className="detail-placeholder">
                <FolderGit2 size={26} aria-hidden="true" />
                <h2>{repository.repository}</h2>
                <p>
                  Select a workflow to inspect its jobs and routing settings.
                </p>
                <dl className="repository-facts">
                  <div>
                    <dt>Branch</dt>
                    <dd>{repository.defaultBranch}</dd>
                  </div>
                  <div>
                    <dt>Head</dt>
                    <dd>{repository.headSha.slice(0, 12)}</dd>
                  </div>
                  <div>
                    <dt>Installation</dt>
                    <dd>#{repository.installationId}</dd>
                  </div>
                  <div>
                    <dt>Refreshed</dt>
                    <dd>{dateLabel(repository.refreshedAt)}</dd>
                  </div>
                </dl>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
