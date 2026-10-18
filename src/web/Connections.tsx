import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Cloud, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";
import { z } from "zod";
import {
  providerSchema,
  ubicloudMachines,
  type Dashboard,
  type Provider,
  type SessionView,
} from "../shared/contracts.js";
import { api, money } from "./api.js";
import { Busy, Dialog, Empty, Failure } from "./components.js";

function ProviderForm({
  provider,
  onClose,
}: Readonly<{ provider?: Provider; onClose: () => void }>) {
  const client = useQueryClient();
  const [projectId, setProjectId] = useState(provider?.projectId ?? "");
  const [token, setToken] = useState("");
  const [runner, setRunner] = useState<string>(
    provider?.runner ?? "ubicloud-standard-2",
  );
  const [priority, setPriority] = useState(provider?.priority ?? 2);
  const [family, setFamily] = useState(
    provider ? (provider.family ?? "account") : "standard",
  );
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      provider
        ? [
            { runner: provider.runner, rateMicros: provider.rateMicros },
            ...(provider.machineRates ?? []),
          ].map((machine) => [
            machine.runner,
            String(machine.rateMicros / 1_000_000),
          ])
        : [],
    ),
  );
  const [budget, setBudget] = useState(
    (provider?.budgetMicros ?? 0) / 1_000_000,
  );
  const connect = useMutation({
    mutationFn: () =>
      api(
        provider ? `/api/providers/${provider.projectId}` : "/api/providers",
        providerSchema,
        provider ? "PUT" : "POST",
        {
          ...(provider ? {} : { projectId, token }),
          runner,
          family,
          priority,
          rateMicros: Math.round(Number(rates[runner]) * 1_000_000),
          budgetMicros: Math.round(budget * 1_000_000),
          machineRates: ubicloudMachines
            .filter(
              (machine) =>
                machine.runner !== runner && rates[machine.runner]?.trim(),
            )
            .map((machine) => ({
              runner: machine.runner,
              rateMicros: Math.round(Number(rates[machine.runner]) * 1_000_000),
            })),
        },
      ),
    onSuccess: async () => {
      setToken("");
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
  });
  function submit(event: SubmitEvent) {
    event.preventDefault();
    connect.mutate();
  }
  return (
    <Dialog
      title={provider ? "Ubicloud settings" : "Connect Ubicloud"}
      onClose={onClose}
    >
      <p className="panel-intro">
        Choose the default machine for paid fallback. BuildFerry never increases
        its size automatically. Saving does not start a runner.
      </p>
      <form className="form-grid" onSubmit={submit}>
        {!provider && (
          <>
            <label className="full">
              <span>Project ID</span>
              <input
                required
                value={projectId}
                maxLength={26}
                onChange={(event) => setProjectId(event.target.value)}
                placeholder="pj..."
              />
            </label>
            <label className="full">
              <span>Project access token</span>
              <input
                type="password"
                required
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
          </>
        )}
        <label>
          <span>Default machine</span>
          <select
            value={runner}
            onChange={(event) => {
              setRunner(event.target.value);
              setFamily(
                event.target.value.includes("premium") ? "premium" : "standard",
              );
            }}
          >
            {ubicloudMachines.map((machine) => (
              <option key={machine.runner} value={machine.runner}>
                {machine.label}
                {family === "account" && machine.runner === runner
                  ? " (Ubicloud account setting)"
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Priority level</span>
          <input
            type="number"
            min={1}
            max={20}
            required
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value))}
          />
        </label>
        <label>
          <span>Actual rate per minute ($)</span>
          <input
            type="number"
            required
            min="0.000001"
            step="0.000001"
            value={rates[runner] ?? ""}
            onChange={(event) =>
              setRates({ ...rates, [runner]: event.target.value })
            }
          />
          <small>Use your Ubicloud account's rate for this machine.</small>
        </label>
        <details className="full">
          <summary>Other machines for job overrides</summary>
          <p className="fine-print">
            Add a rate to allow a job to select another size. Leave blank to
            keep it unavailable.
          </p>
          <div className="form-grid">
            {ubicloudMachines
              .filter((machine) => machine.runner !== runner)
              .map((machine) => (
                <label key={machine.runner}>
                  <span>{machine.label} rate per minute ($)</span>
                  <input
                    type="number"
                    min="0.000001"
                    step="0.000001"
                    value={rates[machine.runner] ?? ""}
                    onChange={(event) =>
                      setRates({
                        ...rates,
                        [machine.runner]: event.target.value,
                      })
                    }
                  />
                </label>
              ))}
          </div>
        </details>
        <label>
          <span>Monthly spend limit ($)</span>
          <input
            type="number"
            required
            min={0}
            max={1000000}
            step="0.01"
            value={budget}
            onChange={(event) => setBudget(Number(event.target.value))}
          />
        </label>
        <div className="full">
          <Failure error={connect.error} />
          <button className="button primary" disabled={connect.isPending}>
            {connect.isPending ? (
              <Busy>Saving settings</Busy>
            ) : (
              <>{provider ? "Save settings" : "Verify and save connection"}</>
            )}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function Connections({
  data,
  session,
}: Readonly<{ data: Dashboard; session: SessionView }>) {
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const canEdit = session.user?.role === "owner" && !session.demo;
  const refresh = useMutation({
    mutationFn: (id: string) =>
      api(`/api/providers/${id}/refresh`, providerSchema, "POST", {}),
    onSettled: () => client.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/providers/${id}`, z.null(), "DELETE"),
    onSuccess: () => client.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>Fallback capacity</h2>
        </div>
        {canEdit && (
          <button className="button secondary" onClick={() => setAdding(true)}>
            <Plus size={15} />
            Connect Ubicloud
          </button>
        )}
      </div>
      {data.providers.length === 0 ? (
        <Empty title="Add your fallback provider">
          Connect Ubicloud for larger runners and paid overflow within your
          limits.
        </Empty>
      ) : (
        <div className="provider-list">
          {data.providers.map((provider) => (
            <article className="provider-row" key={provider.projectId}>
              <span className="provider-icon">
                <Cloud size={23} />
              </span>
              <div>
                <h3>{provider.name}</h3>
                <p>
                  Default:{" "}
                  {
                    ubicloudMachines.find(
                      (machine) => machine.runner === provider.runner,
                    )?.label
                  }
                  <span className="inline-separator">·</span>
                  {money(provider.rateMicros, 6)} per minute (estimate)
                </p>
              </div>
              <div className="provider-budget">
                <strong>{money(provider.budgetMicros)}</strong>
                <span>monthly spend limit</span>
              </div>
              <span className="tier">Priority {provider.priority}</span>
              {canEdit && (
                <>
                  <button
                    className="button secondary"
                    onClick={() => setEditing(provider)}
                  >
                    Edit {provider.name}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Refresh ${provider.name}`}
                    disabled={refresh.isPending}
                    onClick={() => refresh.mutate(provider.projectId)}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button
                    className="text-button danger"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (globalThis.confirm(`Remove ${provider.name}?`))
                        remove.mutate(provider.projectId);
                    }}
                  >
                    Remove
                  </button>
                </>
              )}
            </article>
          ))}
        </div>
      )}
      <Failure error={refresh.error ?? remove.error} />
      <p className="fine-print">
        For Standard x64, turn off automatic Premium in Ubicloud's GitHub
        settings. Native jobs check the supplied hardware before starting. The
        machine never increases in size automatically.
      </p>
      <p className="fine-print">
        Costs use the rates you enter. Install Ubicloud's GitHub runner app on
        each approved worker repository before requesting a run.
      </p>
      {adding && <ProviderForm onClose={() => setAdding(false)} />}
      {editing && (
        <ProviderForm provider={editing} onClose={() => setEditing(null)} />
      )}
    </section>
  );
}

export function TeamSettings({ session }: Readonly<{ session: SessionView }>) {
  const invite = useMutation({
    mutationFn: () =>
      api("/api/invitations", z.object({ url: z.url() }), "POST", {}),
  });
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>1. Connect accounts</h2>
        </div>
      </div>
      <p className="panel-intro">
        Already listed above? Continue to runner setup below. To add someone,
        send them an invitation. Each person signs in once; you manage their
        minutes and limits here. Invitations last one hour.
      </p>
      {session.user?.role === "owner" && (
        <button
          className="button primary"
          disabled={session.demo || invite.isPending}
          onClick={() => invite.mutate()}
        >
          {invite.isPending ? (
            <Busy>Creating invitation</Busy>
          ) : (
            <>
              Create invitation
              <ArrowRight size={15} />
            </>
          )}
        </button>
      )}
      <Failure error={invite.error} />
      {invite.data && (
        <label className="invite-field">
          <span>One-use invitation link</span>
          <input
            readOnly
            value={invite.data.url}
            onFocus={(event) => event.target.select()}
          />
        </label>
      )}
    </section>
  );
}
