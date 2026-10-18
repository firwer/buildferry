import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useState, type SubmitEvent } from "react";
import { ubicloudMachines } from "../shared/contracts.js";
import {
  effectivePolicy,
  type NativeWorkflow,
  type RouteOverride,
  type RoutePolicy,
} from "../shared/native.js";
import { money } from "./api.js";
import { Busy, Failure } from "./components.js";

type Provider = RoutePolicy["providers"][number];
type Job = NativeWorkflow["jobs"][number];

const providerDetails: Record<Provider, { name: string; detail: string }> = {
  github: {
    name: "GitHub-hosted",
    detail: "Free minutes shared across connected accounts.",
  },
  ubicloud: {
    name: "Ubicloud",
    detail: "Paid capacity, only within the job limit.",
  },
};

const machineLabel = (runner: RoutePolicy["ubicloudRunner"]) =>
  ubicloudMachines.find((machine) => machine.runner === runner)?.label ??
  runner ??
  "Provider default";

const providersLabel = (providers: Provider[]) =>
  providers.map((provider) => providerDetails[provider].name).join(" → ");

function ProviderOrder({
  providers,
  onChange,
  disabled,
}: Readonly<{
  providers: Provider[];
  onChange: (providers: Provider[]) => void;
  disabled?: boolean;
}>) {
  const available = (["github", "ubicloud"] as const).filter(
    (provider) => !providers.includes(provider),
  );
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= providers.length) return;
    const next = [...providers];
    const current = next[index];
    const other = next[target];
    if (!current || !other) return;
    next[index] = other;
    next[target] = current;
    onChange(next);
  }
  return (
    <fieldset className="provider-order" aria-label="Provider order">
      {providers.map((provider, index) => {
        const detail = providerDetails[provider];
        return (
          <div className="provider-order-row" key={provider}>
            <span className="provider-rank">{index + 1}</span>
            <div>
              <strong>{detail.name}</strong>
              <small>{detail.detail}</small>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={`Move ${detail.name} up`}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Move ${detail.name} down`}
              disabled={disabled || index === providers.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${detail.name}`}
              disabled={disabled || providers.length === 1}
              onClick={() =>
                onChange(providers.filter((value) => value !== provider))
              }
            >
              <X size={15} />
            </button>
          </div>
        );
      })}
      {available.map((provider) => (
        <button
          type="button"
          className="text-button provider-add"
          key={provider}
          disabled={disabled}
          onClick={() => onChange([...providers, provider])}
        >
          <Plus size={14} />
          Add {providerDetails[provider].name}
        </button>
      ))}
    </fieldset>
  );
}

function overrideRunnerValue(value: RouteOverride["ubicloudRunner"]): string {
  if (value === undefined) return "__inherit";
  return value ?? "__provider";
}

function MachineSelect({
  value,
  onChange,
  disabled,
  label = "Ubicloud machine",
}: Readonly<{
  value: RoutePolicy["ubicloudRunner"];
  onChange: (value: RoutePolicy["ubicloudRunner"]) => void;
  disabled?: boolean;
  label?: string;
}>) {
  const listed = ubicloudMachines.some((machine) => machine.runner === value);
  return (
    <label>
      <span>{label}</span>
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => {
          const machine = ubicloudMachines.find(
            (item) => item.runner === event.target.value,
          );
          onChange(machine?.runner ?? null);
        }}
      >
        <option value="">Provider default</option>
        {ubicloudMachines.map((machine) => (
          <option key={machine.runner} value={machine.runner}>
            {machine.label}
          </option>
        ))}
        {value && !listed && <option value={value}>{value}</option>}
      </select>
    </label>
  );
}

function PolicyFields({
  value,
  onChange,
  disabled,
}: Readonly<{
  value: RoutePolicy;
  onChange: (value: RoutePolicy) => void;
  disabled?: boolean;
}>) {
  return (
    <>
      <fieldset className="policy-fieldset" disabled={disabled}>
        <legend>Providers in order</legend>
        <p>BuildFerry tries the first provider with eligible capacity.</p>
        <ProviderOrder
          providers={value.providers}
          onChange={(providers) => onChange({ ...value, providers })}
          disabled={disabled}
        />
      </fieldset>
      <div className="policy-grid">
        <MachineSelect
          value={value.ubicloudRunner}
          onChange={(ubicloudRunner) => onChange({ ...value, ubicloudRunner })}
          disabled={disabled}
        />
        <label>
          <span>Memory per job (GB)</span>
          <input
            type="number"
            min={1}
            max={120}
            required
            disabled={disabled}
            value={value.memoryGiB}
            onChange={(event) =>
              onChange({ ...value, memoryGiB: Number(event.target.value) })
            }
          />
        </label>
        <label>
          <span>Maximum minutes per job</span>
          <input
            type="number"
            min={2}
            max={180}
            required
            disabled={disabled}
            value={value.maxMinutes}
            onChange={(event) =>
              onChange({ ...value, maxMinutes: Number(event.target.value) })
            }
          />
        </label>
        <label className="policy-cost">
          <span>Maximum cost per job ($)</span>
          <input
            type="number"
            min={0}
            max={1000}
            step="0.001"
            required
            disabled={disabled}
            value={value.maxCostMicros / 1_000_000}
            onChange={(event) =>
              onChange({
                ...value,
                maxCostMicros: Math.round(
                  Number(event.target.value) * 1_000_000,
                ),
              })
            }
          />
          <small>Zero keeps automatic paid spending off.</small>
        </label>
      </div>
    </>
  );
}

export function PolicySummary({ policy }: Readonly<{ policy: RoutePolicy }>) {
  return (
    <dl className="policy-summary">
      <div>
        <dt>Providers</dt>
        <dd>{providersLabel(policy.providers)}</dd>
      </div>
      <div>
        <dt>Ubicloud</dt>
        <dd>{machineLabel(policy.ubicloudRunner)}</dd>
      </div>
      <div>
        <dt>Memory</dt>
        <dd>{policy.memoryGiB} GB</dd>
      </div>
      <div>
        <dt>Time limit</dt>
        <dd>{policy.maxMinutes} min</dd>
      </div>
      <div>
        <dt>Cost limit</dt>
        <dd>{money(policy.maxCostMicros, 3)}</dd>
      </div>
    </dl>
  );
}

export function WorkflowPolicyForm({
  workflow,
  saving,
  error,
  onSave,
}: Readonly<{
  workflow: NativeWorkflow;
  saving: boolean;
  error: Error | null;
  onSave: (enabled: boolean, policy: RoutePolicy) => void;
}>) {
  const [policy, setPolicy] = useState(workflow.policy);
  const [enabled, setEnabled] = useState(workflow.enabled);
  function submit(event: SubmitEvent) {
    event.preventDefault();
    onSave(enabled, policy);
  }
  return (
    <form className="policy-form" onSubmit={submit}>
      <PolicyFields value={policy} onChange={setPolicy} disabled={saving} />
      <label className="check-label policy-enabled">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>Route connected jobs through BuildFerry</span>
      </label>
      <p className="policy-note">
        Every job inherits these settings until it has its own override. Paid
        providers remain unavailable when the cost limit is zero.
      </p>
      <Failure error={error} />
      <button className="button primary" disabled={saving}>
        {saving ? <Busy>Saving settings</Busy> : "Save workflow settings"}
      </button>
    </form>
  );
}

function OverrideNumber({
  label,
  toggleLabel,
  unit,
  inherited,
  value,
  min,
  max,
  step = 1,
  scale = 1,
  onChange,
}: Readonly<{
  label: string;
  toggleLabel: string;
  unit: string;
  inherited: number;
  value: number | undefined;
  min: number;
  max: number;
  step?: number;
  scale?: number;
  onChange: (value: number | undefined) => void;
}>) {
  const enabled = value !== undefined;
  return (
    <div className="override-field">
      <div className="override-head">
        <div>
          <strong>{label}</strong>
          <small>
            Workflow default: {inherited / scale}
            {unit}
          </small>
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            aria-label={toggleLabel}
            checked={enabled}
            onChange={(event) =>
              onChange(event.target.checked ? inherited : undefined)
            }
          />
          <span>Override</span>
        </label>
      </div>
      {enabled ? (
        <input
          type="number"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value / scale}
          onChange={(event) =>
            onChange(Math.round(Number(event.target.value) * scale))
          }
        />
      ) : (
        <span className="inherit-value">
          Inherits {inherited / scale}
          {unit}
        </span>
      )}
    </div>
  );
}

export function JobOverridePanel({
  workflow,
  job,
  saving,
  error,
  onSave,
}: Readonly<{
  workflow: NativeWorkflow;
  job: Job;
  saving: boolean;
  error: Error | null;
  onSave: (override: RouteOverride | null) => void;
}>) {
  const [draft, setDraft] = useState<RouteOverride>(() => ({
    ...workflow.overrides[job.key],
  }));
  const effective = effectivePolicy(workflow, job.key);
  const hasOverride = workflow.overrides[job.key] !== undefined;
  function setNumber(
    key: "memoryGiB" | "maxMinutes" | "maxCostMicros",
    value: number | undefined,
  ) {
    setDraft((previous) => {
      const next = { ...previous };
      if (value === undefined) delete next[key];
      else if (key === "memoryGiB") next.memoryGiB = value;
      else if (key === "maxMinutes") next.maxMinutes = value;
      else next.maxCostMicros = value;
      return next;
    });
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (Object.keys(draft).length === 0) {
      onSave(null);
      return;
    }
    onSave(draft);
  }
  if (!job.supported || job.reusable) {
    return (
      <div className="override-unavailable">
        <strong>This job cannot be routed natively.</strong>
        <p>{job.reason ?? "The workflow structure is not supported."}</p>
        <PolicySummary policy={effectivePolicy(workflow, job.key)} />
      </div>
    );
  }
  return (
    <form className="override-form" onSubmit={submit}>
      <p className="policy-note">
        Unchecked fields inherit the workflow default. An explicit provider list
        replaces the workflow list, and an explicit machine replaces the
        workflow machine.
      </p>
      <div className="override-list">
        <fieldset className="override-field">
          <div className="override-head">
            <div>
              <strong>Providers</strong>
              <small>
                Workflow default: {providersLabel(workflow.policy.providers)}
              </small>
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                aria-label="Override providers"
                checked={draft.providers !== undefined}
                onChange={(event) =>
                  setDraft((previous) => {
                    const next = { ...previous };
                    if (event.target.checked)
                      next.providers = [...effective.providers];
                    else delete next.providers;
                    return next;
                  })
                }
              />
              <span>Override</span>
            </label>
          </div>
          {draft.providers ? (
            <ProviderOrder
              providers={draft.providers}
              onChange={(providers) =>
                setDraft((previous) => ({ ...previous, providers }))
              }
              disabled={saving}
            />
          ) : (
            <span className="inherit-value">
              Inherits {providersLabel(workflow.policy.providers)}
            </span>
          )}
        </fieldset>
        <label className="override-field">
          <span>Ubicloud machine</span>
          <select
            aria-label="Ubicloud machine override"
            value={overrideRunnerValue(draft.ubicloudRunner)}
            onChange={(event) => {
              setDraft((previous) => {
                const next = { ...previous };
                if (event.target.value === "__inherit")
                  delete next.ubicloudRunner;
                else if (event.target.value === "__provider")
                  next.ubicloudRunner = null;
                else {
                  const machine = ubicloudMachines.find(
                    (item) => item.runner === event.target.value,
                  );
                  if (machine) next.ubicloudRunner = machine.runner;
                }
                return next;
              });
            }}
          >
            <option value="__inherit">
              Inherit workflow default (
              {machineLabel(workflow.policy.ubicloudRunner)})
            </option>
            <option value="__provider">Provider default</option>
            {ubicloudMachines.map((machine) => (
              <option key={machine.runner} value={machine.runner}>
                {machine.label}
              </option>
            ))}
          </select>
          <small>
            A selected machine replaces the workflow machine for this job.
          </small>
        </label>
        <OverrideNumber
          label="Memory per job (GB)"
          toggleLabel="Override memory"
          unit=" GB"
          inherited={workflow.policy.memoryGiB}
          value={draft.memoryGiB}
          min={1}
          max={120}
          onChange={(value) => setNumber("memoryGiB", value)}
        />
        <OverrideNumber
          label="Maximum minutes per job"
          toggleLabel="Override time limit"
          unit=" min"
          inherited={workflow.policy.maxMinutes}
          value={draft.maxMinutes}
          min={2}
          max={180}
          onChange={(value) => setNumber("maxMinutes", value)}
        />
        <OverrideNumber
          label="Maximum cost per job ($)"
          toggleLabel="Override cost limit"
          unit=""
          inherited={workflow.policy.maxCostMicros}
          value={draft.maxCostMicros}
          min={0}
          max={1000}
          step={0.001}
          scale={1_000_000}
          onChange={(value) => setNumber("maxCostMicros", value)}
        />
      </div>
      <PolicySummary policy={effective} />
      <Failure error={error} />
      <div className="override-actions">
        {hasOverride && (
          <button
            type="button"
            className="text-button danger"
            disabled={saving}
            onClick={() => {
              setDraft({});
              onSave(null);
            }}
          >
            Use workflow defaults
          </button>
        )}
        <button className="button primary" disabled={saving}>
          {saving ? <Busy>Saving override</Busy> : "Save job override"}
        </button>
      </div>
    </form>
  );
}
