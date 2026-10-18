import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ubicloudMachines,
  type Dashboard,
  type SessionView,
} from "../shared/contracts.js";
import { workerSchema, type Worker } from "../shared/execution.js";
import {
  nativeLeaseSchema,
  type NativeDashboard,
  type NativeLease,
} from "../shared/native.js";
import { api, money, number } from "./api.js";
import { Busy, Empty, External, Failure } from "./components.js";
import { nativeQueryKey, useNativeDashboard } from "./native-data.js";

function workerStatus(worker: Worker | undefined) {
  if (!worker?.nativeSha) return "Not installed";
  return worker.ready ? "Ready" : "Installed";
}

export function WorkerSetup({
  data,
  session,
}: Readonly<{ data: Dashboard; session: SessionView }>) {
  const client = useQueryClient();
  const native = useNativeDashboard();
  const [accountId, setAccountId] = useState<number | null>(null);
  const own = data.accounts.find(
    (account) => account.id === (accountId ?? session.user?.id),
  );
  const worker = native.data?.workers.find(
    (value) => value.accountId === own?.id,
  );
  const install = useMutation({
    mutationFn: async () => {
      if (!own) throw new Error("Choose a connected GitHub account.");
      return api(
        "/api/native/accounts/" + own.id + "/worker",
        workerSchema,
        "POST",
        {},
      );
    },
    onSuccess: (installed) => {
      client.setQueryData<NativeDashboard>(nativeQueryKey, (current) =>
        current
          ? {
              ...current,
              workers: [
                ...current.workers.filter(
                  (value) => value.accountId !== installed.accountId,
                ),
                installed,
              ],
            }
          : current,
      );
    },
  });
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Runner setup</h2>
          <p>
            Install the native launcher in the selected account's private worker
            repository.
          </p>
        </div>
        <span
          className={
            worker?.ready && worker.nativeSha ? "status ready" : "status quiet"
          }
        >
          {workerStatus(worker)}
        </span>
      </div>
      {session.user?.role === "owner" && data.accounts.length > 0 && (
        <label>
          <span>GitHub account</span>
          <select
            value={own?.id ?? ""}
            onChange={(event) => {
              setAccountId(Number(event.target.value));
              install.reset();
            }}
            disabled={install.isPending}
          >
            {data.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.login}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="worker-state">
        <div>
          <span>Worker repository</span>
          <strong>
            {worker?.repository ??
              (own ? own.login + "/buildferry-ci" : "No account selected")}
          </strong>
        </div>
        <div>
          <span>Branch</span>
          <strong>{worker?.branch ?? "main"}</strong>
        </div>
        <div>
          <span>Launcher commit</span>
          <strong>
            {worker?.nativeSha
              ? worker.nativeSha.slice(0, 12)
              : "Not installed"}
          </strong>
        </div>
      </div>
      {worker && (
        <p className="fine-print">
          <External href={"https:" + "//" + "github.com/" + worker.repository}>
            Open worker repository
          </External>
        </p>
      )}
      {session.app && (
        <p className="install-link">
          <External href={session.app.installUrl}>
            Manage GitHub App access
          </External>
        </p>
      )}
      <p className="fine-print">
        The native launcher installs or upgrades from the selected account. No
        project recipe is required.
      </p>
      <Failure error={native.error ?? install.error} />
      <button
        className="button primary"
        disabled={session.demo || !own || install.isPending}
        onClick={() => install.mutate()}
      >
        {install.isPending ? <Busy>Installing runner</Busy> : "Install runner"}
      </button>
    </section>
  );
}

const activeStates = ["queued", "dispatching", "running"] as const;

const conclusionLabel = (run: NativeLease) =>
  run.sourceConclusion ?? (run.state === "completed" ? "success" : run.state);

const conclusionClass = (run: NativeLease) => {
  const value = conclusionLabel(run);
  if (value === "success" || value === "completed") return "status ready";
  if (value === "failure" || value === "failed" || value === "cancelled")
    return "status danger";
  return "status quiet";
};

const machineLabel = (runner: string | null) =>
  ubicloudMachines.find((machine) => machine.runner === runner)?.label ??
  runner ??
  "No machine assigned";

export function Runs() {
  const client = useQueryClient();
  const query = useNativeDashboard();
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api("/api/native/runs/" + id + "/cancel", nativeLeaseSchema, "POST", {}),
    onSuccess: (lease) => {
      client.setQueryData<NativeDashboard>(nativeQueryKey, (current) =>
        current
          ? {
              ...current,
              runs: current.runs.map((run) =>
                run.id === lease.id ? lease : run,
              ),
            }
          : current,
      );
    },
  });
  const repositories = query.data?.repositories ?? [];
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Run history</h2>
          <p>Native runs and the GitHub workflow result they belong to.</p>
        </div>
        <span className="muted small">Refreshes every 30 seconds</span>
      </div>
      <Failure error={query.error ?? cancel.error} />
      {query.isPending && <Busy>Loading runs</Busy>}
      {query.error && (
        <button className="button secondary" onClick={() => query.refetch()}>
          Try again
        </button>
      )}
      {query.data?.runs.length === 0 && (
        <Empty title="No native runs yet">
          Runs appear after a connected workflow dispatches a job to the
          BuildFerry runner.
        </Empty>
      )}
      <div className="run-list">
        {query.data?.runs.map((run) => {
          const repository = repositories.find(
            (item) => item.id === run.repositoryId,
          );
          return (
            <article className="run-card" key={run.id}>
              <div className="run-heading">
                <div>
                  <h3>{run.jobName}</h3>
                  <p>
                    {repository?.repository ?? "Repository unavailable"} /{" "}
                    {run.workflowPath}
                  </p>
                  <small>
                    GitHub run #{run.sourceRunId} · attempt {run.attempt} ·{" "}
                    {run.sourceSha.slice(0, 12)}
                  </small>
                </div>
                <span className={conclusionClass(run)}>
                  {conclusionLabel(run)}
                </span>
              </div>
              <p className="run-message">{run.message}</p>
              <dl className="run-facts">
                <div>
                  <dt>Worker</dt>
                  <dd>{run.worker?.repository ?? "Not assigned"}</dd>
                </div>
                <div>
                  <dt>Machine</dt>
                  <dd>{machineLabel(run.runner)}</dd>
                </div>
                <div>
                  <dt>Labels</dt>
                  <dd>{run.labels.length ? run.labels.join(", ") : "None"}</dd>
                </div>
                <div>
                  <dt>Reserved</dt>
                  <dd>{number(run.reservedMinutes)} min</dd>
                </div>
                <div>
                  <dt>Runner time</dt>
                  <dd>
                    {run.actualMinutes === null
                      ? "Not finished"
                      : number(run.actualMinutes) + " min"}
                  </dd>
                </div>
                <div>
                  <dt>Cost</dt>
                  <dd>
                    {run.actualMicros === null
                      ? money(run.reservedMicros)
                      : money(run.actualMicros)}
                  </dd>
                </div>
              </dl>
              <div className="row-actions">
                <External href={run.sourceUrl}>Open GitHub run</External>
                {run.hostUrl && (
                  <External href={run.hostUrl}>Open runner host</External>
                )}
                {activeStates.includes(
                  run.state as (typeof activeStates)[number],
                ) && (
                  <button
                    className="text-button danger"
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate(run.id)}
                  >
                    Cancel workflow
                  </button>
                )}
                {run.cancellationConfirmed && (
                  <span className="small muted">Cancellation confirmed</span>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
