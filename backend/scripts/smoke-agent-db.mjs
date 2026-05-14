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
  console.error("DATABASE_URL is required to run agent DB smoke.");
  process.exit(1);
}

const repositoryPath = resolve(backendDir, "dist/agent/agentRepository.js");
if (!existsSync(repositoryPath)) {
  console.error("Built repository not found. Run `npm run build -w backend` before db:smoke:agent.");
  process.exit(1);
}

try {
  const { agentRepository } = await import(repositoryPath);
  const task = await agentRepository.createTask({
    query: "agent db smoke persistent task",
    metadata: {
      source: "db_smoke",
      createdBy: "backend/scripts/smoke-agent-db.mjs"
    }
  });

  const event = await agentRepository.createEvent({
    taskId: task.id,
    type: "task.created",
    payload: {
      source: "db_smoke",
      status: task.status
    }
  });

  const snapshot = await agentRepository.getTaskSnapshot(task.id);

  assert(snapshot, "task snapshot was not found");
  assert(snapshot.task.id === task.id, "snapshot task id does not match created task");
  assert(snapshot.task.status === "queued", `expected queued status, got ${snapshot.task.status}`);
  assert(
    snapshot.events.some((item) => item.id === event.id && item.type === "task.created"),
    "task.created event was not found in snapshot"
  );

  console.log("agent db smoke ok");
  console.log(`taskId=${task.id}`);
  console.log(`events=${snapshot.events.length}`);
} catch (error) {
  console.error("agent db smoke failed");
  console.error(error);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

