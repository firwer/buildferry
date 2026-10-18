import { z } from "zod";
import { ubicloudRunnerSchema } from "./contracts.js";
import { shaSchema, workerSchema } from "./execution.js";

export const routePolicySchema = z
  .object({
    providers: z
      .array(z.enum(["github", "ubicloud"]))
      .min(1)
      .max(2)
      .refine(
        (values) => new Set(values).size === values.length,
        "Choose each provider once.",
      ),
    ubicloudRunner: ubicloudRunnerSchema.nullable(),
    ubicloudFamily: z.enum(["account", "standard", "premium"]),
    memoryGiB: z.number().int().min(1).max(120),
    maxMinutes: z.number().int().min(2).max(180),
    maxCostMicros: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
export const routeOverrideSchema = routePolicySchema.partial().strict();
export type RoutePolicy = z.infer<typeof routePolicySchema>;
export type RouteOverride = z.infer<typeof routeOverrideSchema>;
export const defaultRoutePolicy: RoutePolicy = {
  providers: ["github", "ubicloud"],
  ubicloudRunner: null,
  ubicloudFamily: "account",
  memoryGiB: 8,
  maxMinutes: 60,
  maxCostMicros: 0,
};

export const workflowJobSchema = z.object({
  key: z.string(),
  name: z.string(),
  needs: z.array(z.string()),
  runners: z.array(z.string()),
  reusable: z.boolean(),
  matrix: z.boolean(),
  environment: z.string().nullable(),
  maxMinutes: z.number().int().positive().nullable(),
  supported: z.boolean(),
  reason: z.string().nullable(),
  integrated: z.boolean(),
});
export const nativeWorkflowSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  path: z.string(),
  sha: shaSchema,
  jobs: z.array(workflowJobSchema),
  enabled: z.boolean(),
  policy: routePolicySchema,
  overrides: z.record(z.string(), routeOverrideSchema),
  error: z.string().nullable(),
});
export type NativeWorkflow = z.infer<typeof nativeWorkflowSchema>;
export const nativeRepositorySchema = z.object({
  id: z.number().int().positive(),
  repository: z.string(),
  installationId: z.number().int().positive(),
  defaultBranch: z.string(),
  headSha: shaSchema,
  private: z.boolean(),
  refreshedAt: z.number(),
  workflows: z.array(nativeWorkflowSchema),
  error: z.string().nullable(),
});
export type NativeRepository = z.infer<typeof nativeRepositorySchema>;
export const nativeWorkflowSettingsSchema = z
  .object({
    enabled: z.boolean(),
    policy: routePolicySchema,
    overrides: z.record(z.string(), routeOverrideSchema),
  })
  .strict();
export const nativeLeaseSchema = z.object({
  id: z.uuid(),
  repositoryId: z.number().int().positive(),
  workflowId: z.number().int().positive(),
  workflowPath: z.string(),
  jobKey: z.string(),
  jobName: z.string(),
  sourceJobId: z.number().int().positive(),
  sourceRunId: z.number().int().positive(),
  attempt: z.number().int().positive(),
  sourceSha: shaSchema,
  labels: z.array(z.string()),
  policy: routePolicySchema,
  state: z.enum([
    "queued",
    "dispatching",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ]),
  sourceConclusion: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deadline: z.number(),
  accountId: z.number().int().positive().nullable(),
  providerId: z.string().nullable(),
  runner: z.string().nullable(),
  worker: workerSchema.nullable(),
  remoteRunId: z.number().int().positive().nullable(),
  runnerId: z.number().int().positive().nullable(),
  expectedFamily: z.enum(["account", "standard", "premium"]).optional(),
  hostFamily: z.enum(["standard", "premium", "unknown"]).optional(),
  standardRateMicros: z.number().int().nonnegative().optional(),
  premiumRateMicros: z.number().int().nonnegative().optional(),
  submittedAt: z.number().nullable(),
  jitRequestedAt: z.number().nullable(),
  claimedAt: z.number().nullable(),
  period: z.string(),
  reservedMinutes: z.number().int().nonnegative(),
  actualMinutes: z.number().int().nonnegative().nullable(),
  reservedMicros: z.number().int().nonnegative(),
  actualMicros: z.number().int().nonnegative().nullable(),
  cancellationConfirmed: z.boolean(),
  message: z.string(),
  sourceUrl: z.string(),
  hostUrl: z.string().nullable(),
});
export type NativeLease = z.infer<typeof nativeLeaseSchema>;
export const nativeDashboardSchema = z.object({
  repositories: z.array(nativeRepositorySchema),
  runs: z.array(nativeLeaseSchema),
  workers: z.array(workerSchema),
});
export type NativeDashboard = z.infer<typeof nativeDashboardSchema>;

/** An explicit job provider list replaces the workflow list; other fields inherit individually. */
export function effectivePolicy(
  workflow: NativeWorkflow,
  jobKey: string,
): RoutePolicy {
  return routePolicySchema.parse({
    ...workflow.policy,
    ...workflow.overrides[jobKey],
  });
}
