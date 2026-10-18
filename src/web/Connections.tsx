import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Cloud, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";
import { z } from "zod";
import {
  providerSchema,
  type Dashboard,
  type SessionView,
} from "../shared/contracts.js";
import { api, money } from "./api.js";
import { Busy, Dialog, Empty, External, Failure } from "./components.js";

function ProviderForm({ onClose }: Readonly<{ onClose: () => void }>) {
  const client = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [token, setToken] = useState("");
  const [runner, setRunner] = useState("ubicloud-standard-4");
  const [priority, setPriority] = useState(2);
  const [rate, setRate] = useState("");
  const [budget, setBudget] = useState(0);
  const connect = useMutation({
    mutationFn: () =>
      api("/api/providers", providerSchema, "POST", {
        projectId,
        token,
        runner,
        priority,
        rateMicros: Math.round(Number(rate) * 1_000_000),
        budgetMicros: Math.round(budget * 1_000_000),
      }),
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
    <Dialog title="Connect Ubicloud" onClose={onClose}>
      <p className="panel-intro">
        Connect its GitHub runner app to your CI repository in Ubicloud first.
        This step verifies project access without starting a runner.
      </p>
      <form className="form-grid" onSubmit={submit}>
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
        <label>
          <span>Runner size</span>
          <select
            value={runner}
            onChange={(event) => setRunner(event.target.value)}
          >
            <option value="ubicloud-standard-2">2 CPUs / 8 GB</option>
            <option value="ubicloud-standard-4">4 CPUs / 16 GB</option>
            <option value="ubicloud-standard-8">8 CPUs / 32 GB</option>
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
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
          <small>Use the rate for your standard or premium tier.</small>
        </label>
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
              <Busy>Verifying project</Busy>
            ) : (
              "Verify and save connection"
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
          <p className="eyebrow">Extra room when you need it</p>
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
                  Ubicloud / {provider.runner.replace("ubicloud-standard-", "")}{" "}
                  CPUs<span className="inline-separator">·</span>
                  {money(provider.rateMicros)} per minute
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
        Costs use the rates you enter. Install Ubicloud's GitHub runner app on
        each approved worker repository before requesting a run.
      </p>
      {adding && <ProviderForm onClose={() => setAdding(false)} />}
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
          <p className="eyebrow">Build together</p>
          <h2>Connect your team</h2>
        </div>
      </div>
      <p className="panel-intro">
        Each person signs in with their own GitHub account and sets the minutes
        they want to contribute. Invitation links expire in one hour and can be
        used once.
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
      {session.app && (
        <p className="install-link">
          <External href={session.app.installUrl}>
            Manage GitHub repository access
          </External>
        </p>
      )}
    </section>
  );
}
