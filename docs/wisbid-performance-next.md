# Wisbid concurrency rollout

## What the existing code already does

The current Quality test coordinator (`organisation-platform/scripts/run-ci-tests.mts`) saves a complete selected-test plan, uses cached suite durations to order tests, and recycles Jest workers. Coverage runs batches of 50 suites sequentially on one machine and merges their results. The timing cache changes scheduling only, never scope. This is the first candidate for parallel jobs.

The package builder (`scripts/build-workspace-packages.mjs`) already builds topological batches, verifies transitive compiler inputs and restores cached declarations. CI currently sets package concurrency to one; increasing it blindly duplicates memory pressure. The Build job also performs workspace typing, package compilation, app typing, release web builds, assembled profile builds and distribution checks. Those checks remain required.

Image publishing already separates web from a service matrix, keeps the Production environment, and uses dedicated persistent Buildx builders. Preserve that local cache and deployment connectivity. Moving these jobs to fresh account workers can lose more cache benefit than concurrency gains.

## First change after native routing is verified

Partition the exact saved Quality plan into two duration-balanced test jobs initially. Use each suite exactly once, cap combined available account slots and reserve worst-case minutes before dispatch. Move to three shards only if measurements show a net benefit and three usable account workers are connected. A larger monthly allowance alone is not a reason to create more shards.

Keep lint/type checks independent of test shards where their inputs permit it. Preserve the required Quality check as the final aggregate: it must require every selected suite and every other existing Quality check. Merge Istanbul coverage against the complete original changed-source list, including uncovered files. Missing shard results, mismatched plan fingerprints, an empty shard substituting for expected tests, failures or incomplete coverage must fail the aggregate and block Sonar and release. Do not run the old full test command again after the shards.

Compare cold and warm runs of the same revision: time to first failure, total elapsed time, install/cache time, suite balance, rounded host minutes, swap use and peak memory. Keep sharding when the speedup justifies duplicated setup. Free account limits and paid caps still apply.

## Build experiments

1. Measure time per existing build step and cache hit/miss first. Record package compiler time separately from dependency installation and web compilation.
2. Verify cache reuse across account workers. Native source-job caches retain the Wisbid repository identity, so worker account changes should not need distinct package cache keys.
3. Benchmark concurrency two only for independent smaller package batches, with the existing large-package memory guard retained. Leave heavy compiler work serial when memory or swap makes parallelism slower.
4. Evaluate splitting independent host profile validations after package declarations are built once and reused through a verified artifact or matching cache. Avoid rebuilding the full dependency graph in each job.
5. Retain Next's release type checker and both package and app consumption checks. Any removal needs evidence of genuine duplication and separate review.

## Image experiments

Measure changed-image selection, cache restore, builder solve time, package compilation and upload separately. Confirm the service matrix already runs useful parallel builds before adding machines. Reuse immutable image and package artifacts only when their revision, profile, dependency hash and release evidence match. Preserve the persistent main web builder and production approval. First optimize cache misses and avoid rebuilding unchanged images; benchmark moving a builder only after that baseline.

No new sharded execution or speedup is claimed by this document. It records the next implementation and acceptance criteria without weakening the current workflow.
