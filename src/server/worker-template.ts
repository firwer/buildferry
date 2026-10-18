import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stringify } from "yaml";

export const workerWorkflow = "buildferry-worker.yml";
export const workerJobName = "BuildFerry worker";
export const workerSteps = [
  "Prepare immutable source",
  "Preserve checkout audit",
  "Run approved recipe",
] as const;

/** Only dedicated, empty worker repositories receive this pinned launcher. */
export function workerFiles(
  publicUrl: string,
): { path: string; mode: "100644"; type: "blob"; content: string }[] {
  const workflow = {
    name: "BuildFerry worker",
    "run-name": "buildferry:${{ inputs.request_id }}",
    on: {
      workflow_dispatch: {
        inputs: {
          request_id: { required: true, type: "string" },
          runner: { required: true, type: "string" },
          max_minutes: { required: true, type: "string" },
        },
      },
    },
    permissions: {},
    jobs: {
      execute: {
        name: workerJobName,
        "runs-on": "${{ inputs.runner }}",
        "timeout-minutes": "${{ fromJSON(inputs.max_minutes) }}",
        permissions: { contents: "read", "id-token": "write" },
        env: {
          BUILDFERRY_URL: publicUrl,
          BUILDFERRY_REQUEST_ID: "${{ inputs.request_id }}",
        },
        steps: [
          {
            name: "Checkout approved launcher",
            uses: "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
            with: { "persist-credentials": false },
          },
          {
            name: "Setup Node",
            uses: "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
            with: { "node-version": 24 },
          },
          { name: workerSteps[0], run: "node .buildferry/prepare.mjs" },
          {
            name: workerSteps[1],
            uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
            with: {
              name: "buildferry-audit-${{ github.run_attempt }}",
              path: "${{ runner.temp }}/buildferry-audit.json",
              "if-no-files-found": "error",
              "retention-days": 7,
            },
          },
          { name: workerSteps[2], run: "node .buildferry/run.mjs" },
        ],
      },
    },
  };
  const helper = (name: string) =>
    readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../dist/worker",
        `${name}.js`,
      ),
      "utf8",
    );
  return [
    {
      path: `.github/workflows/${workerWorkflow}`,
      mode: "100644",
      type: "blob",
      content: stringify(workflow),
    },
    {
      path: ".buildferry/prepare.mjs",
      mode: "100644",
      type: "blob",
      content: helper("prepare"),
    },
    {
      path: ".buildferry/run.mjs",
      mode: "100644",
      type: "blob",
      content: helper("run"),
    },
  ];
}
