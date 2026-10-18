import { useMutation } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Clock3, GitBranch } from "lucide-react";
import { useState } from "react";
import type { SubmitEvent } from "react";
import { previewResultSchema, shardResultSchema } from "../shared/contracts.js";
import { api, money, number } from "./api.js";
import { Busy, Failure } from "./components.js";

export function Routing() {
  const [jobs, setJobs] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(20);
  const [memoryGiB, setMemoryGiB] = useState(8);
  const [budget, setBudget] = useState(0);
  const preview = useMutation({
    mutationFn: () =>
      api("/api/routing/preview", previewResultSchema, "POST", {
        jobs,
        maxMinutes,
        memoryGiB,
        maxCostMicros: Math.round(budget * 1_000_000),
      }),
  });
  function submit(event: SubmitEvent) {
    event.preventDefault();
    preview.mutate();
  }
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Try your priorities</p>
          <h2>Find a route for your next run</h2>
        </div>
        <GitBranch size={23} className="muted" />
      </div>
      <p className="panel-intro">
        See how parallel jobs would be assigned. This is a preview; it does not
        reserve minutes or start work.
      </p>
      <form className="routing-form" onSubmit={submit}>
        <label>
          <span>Parallel jobs</span>
          <input
            type="number"
            required
            min={1}
            max={12}
            value={jobs}
            onChange={(event) => setJobs(Number(event.target.value))}
          />
        </label>
        <label>
          <span>Maximum minutes per job</span>
          <input
            type="number"
            required
            min={1}
            max={180}
            value={maxMinutes}
            onChange={(event) => setMaxMinutes(Number(event.target.value))}
          />
        </label>
        <label>
          <span>Memory per job</span>
          <select
            value={memoryGiB}
            onChange={(event) => setMemoryGiB(Number(event.target.value))}
          >
            <option value={4}>4 GB</option>
            <option value={8}>8 GB</option>
            <option value={16}>16 GB</option>
            <option value={32}>32 GB</option>
          </select>
        </label>
        <label>
          <span>Total spend limit ($)</span>
          <input
            type="number"
            required
            min={0}
            max={1000000}
            step="0.001"
            value={budget}
            onChange={(event) => setBudget(Number(event.target.value))}
          />
        </label>
        <button className="button primary" disabled={preview.isPending}>
          {preview.isPending ? (
            <Busy>Finding routes</Busy>
          ) : (
            <>
              Preview assignments
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </form>
      <Failure error={preview.error} />
      {preview.data && (
        <div className="preview-results" aria-live="polite">
          <div className="result-heading">
            <strong>Assignment preview</strong>
            <span>
              Estimated compute: {money(preview.data.estimatedCostMicros)}
            </span>
          </div>
          {preview.data.assignments.map((assignment) => (
            <div className="assignment" key={assignment.job}>
              <span className="job-number">
                {assignment.job.toString().padStart(2, "0")}
              </span>
              <div>
                <strong>{assignment.name}</strong>
                <p>{assignment.runner ?? "No worker selected"}</p>
              </div>
              <span className="assignment-arrow">
                <ArrowRight size={17} />
              </span>
              <div className="assignment-reason">{assignment.reason}</div>
              {assignment.candidateId ? (
                <CheckCircle2 size={18} className="green" />
              ) : (
                <Clock3 size={18} className="muted" />
              )}
            </div>
          ))}
          <details>
            <summary>Why other capacity may be unavailable</summary>
            <ul className="reason-list">
              {preview.data.candidates.map((candidate) => (
                <li key={candidate.id}>
                  <strong>{candidate.name}</strong>
                  <span>
                    {candidate.reason ??
                      "Eligible before parallel slot and budget allocation."}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}

export function TestPlanner() {
  const [groups, setGroups] = useState(2);
  const [text, setText] = useState(
    "auth.test, 180\norders.test, 120\ninventory.test, 95\naccounts.test, 80\nsearch.test, 60\nnotifications.test, 45",
  );
  const plan = useMutation({
    mutationFn: () => {
      const suites = text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const [name = "", seconds = ""] = line.split(",");
          return { name: name.trim(), seconds: Number(seconds) };
        });
      return api("/api/tests/plan", shardResultSchema, "POST", {
        groups,
        suites,
      });
    },
  });
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Less waiting, measured</p>
          <h2>Balance your test groups</h2>
        </div>
      </div>
      <p className="panel-intro">
        Paste suite names and their previous durations to compare parallel
        groups. Every suite is assigned once. Setup and transfer time are not
        included.
      </p>
      <form
        className="test-form"
        onSubmit={(event) => {
          event.preventDefault();
          plan.mutate();
        }}
      >
        <label>
          <span>Suites and seconds</span>
          <textarea
            rows={7}
            value={text}
            onChange={(event) => setText(event.target.value)}
            required
            spellCheck={false}
          />
        </label>
        <div>
          <label>
            <span>Parallel groups</span>
            <input
              type="number"
              min={1}
              max={8}
              required
              value={groups}
              onChange={(event) => setGroups(Number(event.target.value))}
            />
          </label>
          <button className="button primary" disabled={plan.isPending}>
            {plan.isPending ? (
              <Busy>Balancing groups</Busy>
            ) : (
              "Compare test groups"
            )}
          </button>
        </div>
      </form>
      <Failure error={plan.error} />
      {plan.data && (
        <div aria-live="polite">
          <p className="test-estimate">
            {number(plan.data.serialSeconds / 60)} min sequential{" "}
            <ArrowRight size={16} />
            <strong>
              {number(plan.data.parallelSeconds / 60)} min of tests in parallel
            </strong>
          </p>
          <div className="shard-grid">
            {plan.data.groups.map((group) => (
              <div className="shard" key={group.id}>
                <strong>
                  Group {group.id}
                  <span>{number(group.seconds / 60)} min</span>
                </strong>
                <ul>
                  {group.suites.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
