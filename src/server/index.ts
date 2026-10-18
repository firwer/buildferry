import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const { server, claimCode } = await createApp(config);
await server.listen({ port: config.port, host: config.host });
console.log(
  `BuildFerry is available at ${config.publicUrl}. ${config.demo ? "Test fixtures only." : "Approved workloads will run on connected workers."}`,
);
if (claimCode) console.log(`One-use setup code: ${claimCode}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
