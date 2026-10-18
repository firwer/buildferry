import { z } from "zod";

const minutes = z.number().int().min(0).max(1_000_000);
const priority = z.number().int().min(1).max(20);
const micros = z.number().int().min(0).max(1_000_000_000_000);
export const loginSchema = z
  .string()
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/);
export const repositorySchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/);
export const accountSettingsSchema = z
  .object({
    includedMinutes: minutes,
    contributionMinutes: minutes,
    reserveMinutes: minutes,
    priority,
    weight: z.number().int().min(1).max(10),
    concurrency: z.number().int().min(1).max(20),
    state: z.enum(["active", "paused", "draining"]),
    workerRepository: repositorySchema.or(z.literal("")),
    allowanceConfirmed: z.boolean(),
  })
  .strict()
  .refine(
    (value) => value.reserveMinutes <= value.includedMinutes,
    "The reserve exceeds the allowance.",
  );

export const accountSchema = z.object({
  id: z.number().int().positive(),
  login: loginSchema,
  role: z.enum(["owner", "member"]),
  settings: accountSettingsSchema,
  usedMinutes: minutes.nullable(),
  period: z.string(),
  verifiedAt: z.number().nullable(),
  repositoryVerified: z.boolean(),
  message: z.string(),
});
export type Account = z.infer<typeof accountSchema>;
export type AccountSettings = z.infer<typeof accountSettingsSchema>;

export const providerInputSchema = z
  .object({
    projectId: z.string().regex(/^pj[0-9a-hj-km-np-tv-z]{24}$/),
    token: z.string().min(10).max(4096),
    runner: z.enum([
      "ubicloud-standard-2",
      "ubicloud-standard-4",
      "ubicloud-standard-8",
    ]),
    priority,
    rateMicros: micros.refine(
      (value) => value > 0,
      "Enter the actual runner rate.",
    ),
    budgetMicros: micros,
  })
  .strict();
export const providerSchema = providerInputSchema.omit({ token: true }).extend({
  name: z.string(),
  installations: z.array(z.object({ id: z.string(), name: z.string() })),
  verifiedAt: z.number(),
});
export type Provider = z.infer<typeof providerSchema>;

export const previewInputSchema = z
  .object({
    jobs: z.number().int().min(1).max(12),
    maxMinutes: z.number().int().min(1).max(180),
    memoryGiB: z.number().int().min(1).max(64),
    maxCostMicros: micros,
  })
  .strict();
export type PreviewInput = z.infer<typeof previewInputSchema>;
export const candidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["github", "ubicloud"]),
  runner: z.string(),
  priority,
  weight: z.number().positive(),
  concurrency: z.number().int().min(1),
  availableMinutes: minutes,
  capacityMinutes: minutes.optional(),
  pendingMinutes: minutes.optional(),
  availableMicros: micros,
  rateMicros: micros,
  memoryGiB: z.number().positive(),
  reason: z.string().nullable(),
});
export type Candidate = z.infer<typeof candidateSchema>;
export const previewResultSchema = z.object({
  assignments: z.array(
    z.object({
      job: z.number(),
      candidateId: z.string().nullable(),
      name: z.string(),
      runner: z.string().nullable(),
      costMicros: micros,
      reason: z.string(),
    }),
  ),
  candidates: z.array(candidateSchema),
  estimatedCostMicros: micros,
});
export type PreviewResult = z.infer<typeof previewResultSchema>;

export const shardInputSchema = z
  .object({
    groups: z.number().int().min(1).max(8),
    suites: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            seconds: z.number().positive().max(86400),
          })
          .strict(),
      )
      .min(1)
      .max(20_000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.suites.map((suite) => suite.name)).size ===
      value.suites.length,
    "Each suite must appear once.",
  );
export type ShardInput = z.infer<typeof shardInputSchema>;
export const shardResultSchema = z.object({
  groups: z.array(
    z.object({
      id: z.number(),
      seconds: z.number(),
      suites: z.array(z.string()),
    }),
  ),
  serialSeconds: z.number(),
  parallelSeconds: z.number(),
});
export type ShardResult = z.infer<typeof shardResultSchema>;

export const sessionSchema = z.object({
  stage: z.enum(["claim", "setup", "login", "dashboard"]),
  demo: z.boolean(),
  csrf: z.string(),
  user: z
    .object({
      id: z.number(),
      login: z.string(),
      role: z.enum(["owner", "member"]),
    })
    .nullable(),
  app: z.object({ slug: z.string(), installUrl: z.string() }).nullable(),
  publicUrl: z.string(),
});
export type SessionView = z.infer<typeof sessionSchema>;
export const dashboardSchema = z.object({
  accounts: z.array(accountSchema),
  providers: z.array(providerSchema),
  candidates: z.array(candidateSchema),
  period: z.string(),
  activity: z.array(
    z.object({ id: z.number(), at: z.number(), message: z.string() }),
  ),
});
export type Dashboard = z.infer<typeof dashboardSchema>;
