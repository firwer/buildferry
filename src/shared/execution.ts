import { z } from "zod";
import { repositorySchema, loginSchema } from "./contracts.js";

export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const repoNameSchema = z.string().refine((value) => {
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    loginSchema.safeParse(parts[0]).success &&
    repositorySchema.safeParse(parts[1]).success
  );
}, "Use owner/repository.");
export const recipeSchema = z
  .object({
    name: z.string().trim().min(1).max(70),
    directory: z
      .string()
      .max(200)
      .regex(/^(?:\.|[a-zA-Z0-9_-][a-zA-Z0-9_./-]*)$/)
      .refine(
        (value) => !value.split("/").includes(".."),
        "Use a directory inside the repository.",
      ),
    commands: z.array(z.string().trim().min(1).max(4000)).min(1).max(20),
    maxMinutes: z.number().int().min(2).max(180),
    memoryGiB: z.number().int().min(1).max(64),
    maxCostMicros: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;
export const projectInputSchema = z
  .object({
    repository: repoNameSchema,
    recipe: recipeSchema,
    onPush: z.boolean().default(false),
  })
  .strict();
export const projectSchema = projectInputSchema.extend({
  id: z.uuid(),
  repositoryId: z.number().int().positive(),
  ownerId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  defaultBranch: z.string(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Project = z.infer<typeof projectSchema>;
export const workerSchema = z.object({
  accountId: z.number().int().positive(),
  repository: repoNameSchema,
  repositoryId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  branch: z.string(),
  sha: shaSchema,
  ready: z.boolean(),
  createdAt: z.number(),
  allowedProjects: z.array(z.uuid()),
});
export type Worker = z.infer<typeof workerSchema>;
export const jobSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  sourceSha: shaSchema,
  recipe: recipeSchema,
  recipeHash: digestSchema,
  state: z.enum([
    "queued",
    "dispatching",
    "running",
    "cancelling",
    "finalizing",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  priority: z.number().int().min(1).max(5),
  route: z.enum(["auto", "github", "ubicloud"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  deadline: z.number(),
  accountId: z.number().int().positive().nullable(),
  providerId: z.string().nullable(),
  runner: z.string().nullable(),
  worker: workerSchema.nullable(),
  remoteRunId: z.number().int().positive().nullable(),
  checkId: z.number().int().positive().nullable(),
  checkSubmittedAt: z.number().nullable(),
  checkStartedAt: z.number().nullable().default(null),
  outcome: z.enum(["succeeded", "failed", "cancelled"]).nullable(),
  period: z.string(),
  reservedMinutes: z.number().int().nonnegative(),
  actualMinutes: z.number().int().nonnegative().nullable(),
  reservedMicros: z.number().int().nonnegative(),
  actualMicros: z.number().int().nonnegative().nullable(),
  bootstrapAt: z.number().nullable(),
  submittedAt: z.number().nullable(),
  preparedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  queueSeconds: z.number().nonnegative().nullable(),
  commandSeconds: z.number().nonnegative().nullable(),
  message: z.string(),
  url: z.string().nullable(),
  cancellationConfirmed: z.boolean(),
});
export type Job = z.infer<typeof jobSchema>;
export const enqueueSchema = z
  .object({
    projectId: z.uuid(),
    sha: shaSchema.optional(),
    priority: z.number().int().min(1).max(5).default(3),
    route: z.enum(["auto", "github", "ubicloud"]).default("auto"),
  })
  .strict();
export const executionDashboardSchema = z.object({
  projects: z.array(projectSchema),
  workers: z.array(workerSchema),
  jobs: z.array(jobSchema),
});
export const auditSchema = z
  .object({
    version: z.literal(1),
    requestId: z.uuid(),
    sourceRepositoryId: z.number().int().positive(),
    sourceSha: shaSchema,
    recipeHash: digestSchema,
    workerRepositoryId: z.number().int().positive(),
    workerSha: shaSchema,
    runId: z.number().int().positive(),
    attempt: z.literal(1),
  })
  .strict();
