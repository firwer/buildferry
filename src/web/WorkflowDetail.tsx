import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, ListTree } from "lucide-react";
import { useState } from "react";
import {
  nativeRepositorySchema,
  type NativeRepository,
  type NativeWorkflow,
  type RouteOverride,
  type RoutePolicy,
} from "../shared/native.js";
import { api } from "./api.js";
import { External } from "./components.js";
import { DependencyMap } from "./DependencyMap.js";
import { replaceNativeRepository } from "./native-data.js";
import { JobOverridePanel, WorkflowPolicyForm } from "./RoutePolicyEditor.js";

function routingLabel(job: NativeWorkflow["jobs"][number]) {
  if (job.reusable) return "Uses another workflow";
  return job.integrated ? "BuildFerry runner" : "Not using BuildFerry";
}

function JobBadges({ job }: Readonly<{ job: NativeWorkflow["jobs"][number] }>) {
  return (
    <span className="job-badges">
      {!job.reusable && (
        <span className={job.integrated ? "badge connected" : "badge unrouted"}>
          {routingLabel(job)}
        </span>
      )}
      {job.reusable && <span className="badge">Uses another workflow</span>}
      {!job.supported && !job.reusable && (
        <span className="badge warning">Unsupported</span>
      )}
      {job.environment && <span className="badge">Env: {job.environment}</span>}
      {job.matrix && <span className="badge">Matrix</span>}
      {job.maxMinutes !== null && (
        <span className="badge">{job.maxMinutes} min limit</span>
      )}
    </span>
  );
}

export function WorkflowDetail({
  repository,
  workflow,
}: Readonly<{ repository: NativeRepository; workflow: NativeWorkflow }>) {
  const client = useQueryClient();
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const selectedJob =
    workflow.jobs.find((job) => job.key === selectedJobKey) ?? null;
  const endpoint =
    "/api/native/repositories/" + repository.id + "/workflows/" + workflow.id;
  const settings = useMutation({
    mutationFn: (input: { enabled: boolean; policy: RoutePolicy }) =>
      api(endpoint, nativeRepositorySchema, "PUT", {
        enabled: input.enabled,
        policy: input.policy,
        overrides: workflow.overrides,
      }),
    onSuccess: (updated) => replaceNativeRepository(client, updated),
  });
  const override = useMutation({
    mutationFn: (input: { jobKey: string; value: RouteOverride | null }) => {
      const overrides = { ...workflow.overrides };
      if (input.value === null) delete overrides[input.jobKey];
      else overrides[input.jobKey] = input.value;
      return api(endpoint, nativeRepositorySchema, "PUT", {
        enabled: workflow.enabled,
        policy: workflow.policy,
        overrides,
      });
    },
    onSuccess: (updated) => replaceNativeRepository(client, updated),
  });
  function selectJob(key: string) {
    override.reset();
    setSelectedJobKey(key);
  }
  return (
    <article
      className="workflow-detail"
      aria-label={workflow.name + " workflow"}
    >
      <header className="workflow-header">
        <div>
          <div className="workflow-title-line">
            <h2>{workflow.name}</h2>
            <span
              className={workflow.enabled ? "status ready" : "status quiet"}
            >
              {workflow.enabled ? "Enabled" : "Paused"}
            </span>
          </div>
          <p>{workflow.path}</p>
        </div>
        <External
          href={
            "https:" +
            "//" +
            "github.com/" +
            repository.repository +
            "/blob/" +
            repository.defaultBranch +
            "/" +
            workflow.path
          }
        >
          Open workflow
        </External>
      </header>
      <div className="workflow-facts">
        <span>
          <GitBranch size={14} />
          {repository.defaultBranch}
        </span>
        <span>Head {repository.headSha.slice(0, 12)}</span>
        <span>{workflow.jobs.length} jobs</span>
        <span>
          Refreshed {new Date(repository.refreshedAt).toLocaleString()}
        </span>
      </div>
      {workflow.error && (
        <p className="error" role="alert">
          {workflow.error}
        </p>
      )}
      <section className="map-section" aria-labelledby="dependency-heading">
        <div className="section-heading">
          <div>
            <h3 id="dependency-heading">Dependencies</h3>
            <p>Jobs keep their existing dependencies.</p>
          </div>
          <ListTree size={19} className="muted" aria-hidden="true" />
        </div>
        {workflow.jobs.length ? (
          <DependencyMap
            jobs={workflow.jobs}
            selectedJobKey={selectedJobKey}
            onSelect={selectJob}
          />
        ) : (
          <p className="empty-inline">
            No jobs could be read from this workflow file.
          </p>
        )}
      </section>
      <div className="workflow-workspace">
        <section className="job-panel" aria-labelledby="jobs-heading">
          <div className="section-heading">
            <h3 id="jobs-heading">Jobs</h3>
            <span>{workflow.jobs.length}</span>
          </div>
          <div className="job-list">
            {workflow.jobs.map((job) => (
              <button
                type="button"
                className={
                  selectedJobKey === job.key ? "job-row selected" : "job-row"
                }
                key={job.key}
                aria-pressed={selectedJobKey === job.key}
                aria-label={"Configure " + job.name + " job"}
                onClick={() => selectJob(job.key)}
              >
                <span className="job-row-main">
                  <strong>{job.name}</strong>
                  <small>{job.key}</small>
                </span>
                <span className="job-row-runner">
                  {job.reusable && "Uses another workflow"}
                  {!job.reusable &&
                    (job.integrated
                      ? "BuildFerry connected"
                      : "Uses current runner")}
                </span>
                <JobBadges job={job} />
              </button>
            ))}
          </div>
        </section>
        <section className="settings-panel" aria-live="polite">
          <div className="settings-switch">
            <button
              type="button"
              className={
                selectedJobKey === null
                  ? "settings-tab selected"
                  : "settings-tab"
              }
              aria-pressed={selectedJobKey === null}
              onClick={() => {
                override.reset();
                setSelectedJobKey(null);
              }}
            >
              Workflow defaults
            </button>
            {selectedJob && (
              <span>
                Override for <strong>{selectedJob.name}</strong>
              </span>
            )}
          </div>
          {selectedJob ? (
            <>
              <div className="settings-heading">
                <div>
                  <h3>{selectedJob.name}</h3>
                  <p>{selectedJob.key}</p>
                </div>
                <JobBadges job={selectedJob} />
              </div>
              <JobFacts job={selectedJob} />
              <JobOverridePanel
                key={
                  selectedJob.key +
                  ":" +
                  JSON.stringify(workflow.overrides[selectedJob.key] ?? null)
                }
                workflow={workflow}
                job={selectedJob}
                saving={override.isPending}
                error={override.error}
                onSave={(value) =>
                  override.mutate({ jobKey: selectedJob.key, value })
                }
              />
            </>
          ) : (
            <>
              <div className="settings-heading">
                <div>
                  <h3>Workflow defaults</h3>
                  <p>
                    {Object.keys(workflow.overrides).length} job
                    {Object.keys(workflow.overrides).length === 1
                      ? ""
                      : "s"}{" "}
                    with overrides
                  </p>
                </div>
              </div>
              <WorkflowPolicyForm
                key={
                  workflow.id +
                  ":" +
                  JSON.stringify(workflow.policy) +
                  ":" +
                  workflow.enabled
                }
                workflow={workflow}
                saving={settings.isPending}
                error={settings.error}
                onSave={(enabled, policy) =>
                  settings.mutate({ enabled, policy })
                }
              />
            </>
          )}
        </section>
      </div>
    </article>
  );
}

function JobFacts({ job }: Readonly<{ job: NativeWorkflow["jobs"][number] }>) {
  return (
    <dl className="job-facts">
      <div>
        <dt>Runs on</dt>
        <dd>
          {job.runners.length ? job.runners.join(", ") : "No runner label"}
        </dd>
      </div>
      <div>
        <dt>Environment</dt>
        <dd>{job.environment ?? "None"}</dd>
      </div>
      <div>
        <dt>Routing</dt>
        <dd>{routingLabel(job)}</dd>
      </div>
      <div>
        <dt>Workflow type</dt>
        <dd>{job.reusable ? "Reusable workflow call" : "Inline job"}</dd>
      </div>
      <div>
        <dt>Timeout</dt>
        <dd>{job.maxMinutes === null ? "Not set" : `${job.maxMinutes} min`}</dd>
      </div>
      <div>
        <dt>Matrix</dt>
        <dd>{job.matrix ? "Configured" : "None"}</dd>
      </div>
      {!job.supported && (
        <div className="full">
          <dt>Not routable</dt>
          <dd>
            {job.reason ?? "This job is not supported by the native runner."}
          </dd>
        </div>
      )}
    </dl>
  );
}
