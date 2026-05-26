import { config } from "../config/env.js";
import { InMemoryAgentTaskStore, type AgentTaskStore } from "./taskStore.js";
import { SqliteAgentTaskStore } from "./sqliteTaskStore.js";

export function createAgentTaskStore(): AgentTaskStore {
  if (config.agentTask.store === "memory") {
    return new InMemoryAgentTaskStore();
  }

  return new SqliteAgentTaskStore(config.agentTask.dbPath);
}

export const agentTaskStore: AgentTaskStore = createAgentTaskStore();
