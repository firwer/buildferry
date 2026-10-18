import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitFork, RefreshCw, Settings2 } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";
import { z } from "zod";
import {
  accountSchema,
  type Account,
  type AccountSettings,
  type Dashboard,
  type SessionView,
} from "../shared/contracts.js";
import { api, number } from "./api.js";
import { Busy, Dialog, Empty, Failure } from "./components.js";

function AccountEditor({
  account,
  onClose,
}: Readonly<{ account: Account; onClose: () => void }>) {
  const client = useQueryClient();
  const [settings, setSettings] = useState(account.settings);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/accounts/${account.id}`, accountSchema, "PUT", settings),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
  });
  function numeric(
    key: keyof Pick<
      AccountSettings,
      | "includedMinutes"
      | "contributionMinutes"
      | "reserveMinutes"
      | "priority"
      | "weight"
      | "concurrency"
    >,
    value: string,
  ) {
    setSettings((previous) => ({ ...previous, [key]: Number(value) }));
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <Dialog title={`Settings for ${account.login}`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <label>
          <span>Included minutes</span>
          <input
            type="number"
            min={0}
            max={1000000}
            required
            value={settings.includedMinutes}
            onChange={(event) => numeric("includedMinutes", event.target.value)}
          />
        </label>
        <label>
          <span>Contribution limit</span>
          <input
            type="number"
            min={0}
            max={1000000}
            required
            value={settings.contributionMinutes}
            onChange={(event) =>
              numeric("contributionMinutes", event.target.value)
            }
          />
        </label>
        <label>
          <span>Personal reserve</span>
          <input
            type="number"
            min={0}
            max={settings.includedMinutes}
            required
            value={settings.reserveMinutes}
            onChange={(event) => numeric("reserveMinutes", event.target.value)}
          />
        </label>
        <label>
          <span>Priority level</span>
          <input
            type="number"
            min={1}
            max={20}
            required
            value={settings.priority}
            onChange={(event) => numeric("priority", event.target.value)}
          />
        </label>
        <label>
          <span>Share weight</span>
          <input
            type="number"
            min={1}
            max={10}
            required
            value={settings.weight}
            onChange={(event) => numeric("weight", event.target.value)}
          />
        </label>
        <label>
          <span>Parallel jobs</span>
          <input
            type="number"
            min={1}
            max={20}
            required
            value={settings.concurrency}
            onChange={(event) => numeric("concurrency", event.target.value)}
          />
        </label>
        <label className="full">
          <span>Private CI repository name</span>
          <input
            value={settings.workerRepository}
            placeholder="buildferry-ci"
            maxLength={100}
            onChange={(event) =>
              setSettings((previous) => ({
                ...previous,
                workerRepository: event.target.value,
              }))
            }
          />
          <small>
            Owned by {account.login}. Install your GitHub App on it first.
          </small>
        </label>
        <label className="full">
          <span>Contribution status</span>
          <select
            value={settings.state}
            onChange={(event) =>
              setSettings((previous) => ({
                ...previous,
                state: z
                  .enum(["active", "paused", "draining"])
                  .parse(event.target.value),
              }))
            }
          >
            <option value="active">Available</option>
            <option value="paused">Paused</option>
            <option value="draining">Finishing current work</option>
          </select>
        </label>
        <label className="check-label full">
          <input
            type="checkbox"
            checked={settings.allowanceConfirmed}
            onChange={(event) =>
              setSettings((previous) => ({
                ...previous,
                allowanceConfirmed: event.target.checked,
              }))
            }
          />
          <span>I confirm this allowance resets each calendar month.</span>
        </label>
        <div className="full">
          <Failure error={save.error} />
          <button className="button primary" disabled={save.isPending}>
            {save.isPending ? (
              <Busy>Saving and verifying</Busy>
            ) : (
              "Save settings"
            )}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AccountCard({
  account,
  session,
  available,
}: Readonly<{ account: Account; session: SessionView; available: number }>) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const refresh = useMutation({
    mutationFn: () =>
      api(`/api/accounts/${account.id}/refresh`, accountSchema, "POST", {}),
    onSuccess: () => client.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/accounts/${account.id}`, z.null(), "DELETE"),
    onSuccess: () => client.invalidateQueries({ queryKey: ["dashboard"] }),
  });
  const canManage = session.user?.id === account.id && !session.demo;
  const canRefresh =
    !session.demo && (canManage || session.user?.role === "owner");
  return (
    <article className="account-card">
      <div className="account-heading">
        <span className="avatar">
          {account.login.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h3>{account.login}</h3>
          <span className="muted small">
            <GitFork size={12} />
            GitHub account
          </span>
        </div>
        <span className="tier">Priority {account.settings.priority}</span>
      </div>
      <div className="account-capacity">
        <strong>{number(available)}</strong>
        <span>verified minutes before queued reservations</span>
      </div>
      <progress
        max={Math.max(account.settings.includedMinutes, 1)}
        value={account.usedMinutes ?? 0}
        aria-label={`Minutes used by ${account.login}`}
      />
      <div className="usage-labels">
        <span>
          {account.usedMinutes === null
            ? "Not verified"
            : `${number(account.usedMinutes)} used`}
        </span>
        <span>{number(account.settings.includedMinutes)} included</span>
      </div>
      <div className="account-meta">
        <span>
          Personal reserve{" "}
          <strong>{number(account.settings.reserveMinutes)} min</strong>
        </span>
        <span>
          Parallel limit <strong>{account.settings.concurrency} jobs</strong>
        </span>
      </div>
      <p className="connection-note">{account.message}</p>
      <div className="card-actions">
        <span className={`status ${available > 0 ? "ready" : "quiet"}`}>
          {available > 0 ? "Available" : "Needs attention"}
        </span>
        <div>
          {canRefresh && (
            <button
              className="icon-button"
              type="button"
              aria-label={`Refresh ${account.login}`}
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              <RefreshCw
                size={16}
                className={refresh.isPending ? "spinner" : ""}
              />
            </button>
          )}
          {canManage && (
            <button
              className="icon-button"
              type="button"
              aria-label={`Edit ${account.login}`}
              onClick={() => setEditing(true)}
            >
              <Settings2 size={16} />
            </button>
          )}
        </div>
      </div>
      {(session.user?.role === "owner" || canManage) &&
        account.role !== "owner" &&
        !session.demo && (
          <button
            className="text-button danger"
            disabled={remove.isPending}
            onClick={() => {
              if (
                globalThis.confirm(
                  `Disconnect ${account.login} and remove its stored access?`,
                )
              )
                remove.mutate();
            }}
          >
            Disconnect account
          </button>
        )}
      <Failure error={refresh.error ?? remove.error} />
      {editing && (
        <AccountEditor account={account} onClose={() => setEditing(false)} />
      )}
    </article>
  );
}

export function Accounts({
  data,
  session,
}: Readonly<{ data: Dashboard; session: SessionView }>) {
  return data.accounts.length ? (
    <div className="account-grid">
      {data.accounts.map((account) => {
        const candidate = data.candidates.find(
          (item) => item.id === `github:${account.id}`,
        );
        return (
          <AccountCard
            key={account.id}
            account={account}
            session={session}
            available={
              candidate && !candidate.reason ? candidate.availableMinutes : 0
            }
          />
        );
      })}
    </div>
  ) : (
    <Empty title="Connect your first account">
      Invite a teammate or reconnect your own account to bring its capacity into
      view.
    </Empty>
  );
}
