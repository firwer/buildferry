import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NativeWorkflow } from "../shared/native.js";

type Job = NativeWorkflow["jobs"][number];
type Edge = { from: string; to: string; path: string };

function dependencyLayers(jobs: Job[]) {
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  function level(key: string): number {
    const known = levels.get(key);
    if (known !== undefined) return known;
    const job = byKey.get(key);
    if (!job || visiting.has(key)) return -1;
    visiting.add(key);
    const parents = job.needs
      .filter((need) => byKey.has(need))
      .map((need) => level(need) + 1)
      .filter((value) => value > 0);
    visiting.delete(key);
    const value = parents.length ? Math.max(...parents) : 0;
    levels.set(key, value);
    return value;
  }
  for (const job of jobs) level(job.key);
  const layers: Job[][] = [];
  for (const job of jobs) {
    const index = levels.get(job.key) ?? 0;
    const layer = layers[index] ?? [];
    layer.push(job);
    layers[index] = layer;
  }
  return layers.filter((layer) => layer.length > 0);
}

function jobState(job: Job) {
  if (job.reusable) return "called workflow";
  if (!job.supported) return "existing runner";
  return job.integrated ? "connected" : "not connected";
}

export function DependencyMap({
  jobs,
  selectedJobKey,
  onSelect,
}: Readonly<{
  jobs: Job[];
  selectedJobKey: string | null;
  onSelect: (key: string) => void;
}>) {
  const descriptionId = useId();
  const mapRef = useRef<HTMLFieldSetElement>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const layers = useMemo(() => dependencyLayers(jobs), [jobs]);
  const relations = jobs.flatMap((job) =>
    job.needs.length
      ? job.needs.map((need) => `${job.name} needs ${need}`)
      : [`${job.name} has no dependencies`],
  );

  useLayoutEffect(() => {
    const container = mapRef.current;
    if (!container) return;
    function measure() {
      const current = mapRef.current;
      if (!current) return;
      const bounds = current.getBoundingClientRect();
      const next: Edge[] = [];
      for (const job of jobs) {
        const target = nodes.current.get(job.key);
        if (!target) continue;
        const targetRect = target.getBoundingClientRect();
        for (const need of job.needs) {
          const source = nodes.current.get(need);
          if (!source) continue;
          const sourceRect = source.getBoundingClientRect();
          if (sourceRect.width === 0 || targetRect.width === 0) continue;
          const x1 = sourceRect.right - bounds.left;
          const y1 = sourceRect.top + sourceRect.height / 2 - bounds.top;
          const x2 = targetRect.left - bounds.left;
          const y2 = targetRect.top + targetRect.height / 2 - bounds.top;
          const distance = Math.max(30, Math.abs(x2 - x1) * 0.45);
          next.push({
            from: need,
            to: job.key,
            path: `M ${x1} ${y1} C ${x1 + distance} ${y1}, ${x2 - distance} ${y2}, ${x2} ${y2}`,
          });
        }
      }
      setSize({ width: current.clientWidth, height: current.clientHeight });
      setEdges(next);
    }
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    observer?.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [jobs, layers]);

  return (
    <div className="dependency-map-wrap">
      <fieldset
        className="dependency-map"
        ref={mapRef}
        aria-label="Job dependency map"
        aria-describedby={descriptionId}
      >
        <svg
          className="dependency-edges"
          viewBox={`0 0 ${Math.max(size.width, 1)} ${Math.max(size.height, 1)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {edges.map((edge) => (
            <path key={`${edge.from}-${edge.to}`} d={edge.path} />
          ))}
        </svg>
        <div className="dependency-layers">
          {layers.map((layer, index) => (
            <div
              className="dependency-layer"
              key={layer.map((job) => job.key).join(":")}
            >
              <span className="layer-label">
                {index === 0 ? "Starts" : `Step ${index + 1}`}
              </span>
              {layer.map((job) => (
                <button
                  type="button"
                  className={
                    selectedJobKey === job.key
                      ? "job-node selected"
                      : "job-node"
                  }
                  key={job.key}
                  aria-pressed={selectedJobKey === job.key}
                  aria-label={`${job.name} job. ${
                    job.needs.length
                      ? `Needs ${job.needs.join(", ")}.`
                      : "No dependencies."
                  } Native integration ${jobState(job)}.`}
                  ref={(node) => {
                    if (node) nodes.current.set(job.key, node);
                    else nodes.current.delete(job.key);
                  }}
                  onClick={() => onSelect(job.key)}
                >
                  <span className="job-node-key">{job.key}</span>
                  <strong>{job.name}</strong>
                  <span className="job-node-runner">
                    {job.reusable ? "Called workflow" : "Current runner"}
                  </span>
                  <span className="job-node-badges">
                    {job.integrated && (
                      <span className="badge connected">BuildFerry runner</span>
                    )}
                    {!job.integrated && !job.reusable && (
                      <span className="badge unrouted">
                        Not using BuildFerry
                      </span>
                    )}
                    {job.reusable && (
                      <span className="badge">Uses another workflow</span>
                    )}
                    {!job.supported && !job.reusable && (
                      <span className="badge warning">Unsupported</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </fieldset>
      <p id={descriptionId} className="visually-hidden">
        Dependency relationships: {relations.join(". ")}.
      </p>
    </div>
  );
}
