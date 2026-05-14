import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = resolve(backendDir, "..");

dotenv.config({ path: resolve(rootDir, ".env.local"), override: false });
dotenv.config({ path: resolve(backendDir, ".env.local"), override: false });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to run the agent worker.");
  process.exit(1);
}

if (!process.env.REDIS_URL) {
  console.error("REDIS_URL is required to run the agent worker.");
  process.exit(1);
}

const workerPath = resolve(backendDir, "dist/agent/agentWorker.js");
if (!existsSync(workerPath)) {
  console.error("Built worker not found. Run `npm run build -w backend` before agent:worker.");
  process.exit(1);
}

const { startAgentWorker } = await import(workerPath);
const worker = await startAgentWorker();

async function shutdown(signal) {
  console.log(`agent worker received ${signal}; shutting down`);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
