import { Router } from "express";
import { getCurrentUserContext, type UserContext } from "../auth/session.js";
import { agentRepository } from "../agent/agentRepository.js";
import { completeTask, createTask, failTask, getTask } from "../agent/agentTaskStore.js";
import type {
  AgentSearchTaskStartApiResponse,
  AgentTaskApiResponse,
  RunDemoSearchAgent
} from "../agent/agentTypes.js";
import { parseDemoSearchRequest, type DemoSearchRequest } from "../services/demoSearch.service.js";
import { HttpError } from "../utils/httpError.js";

const RUN_DEMO_SEARCH_AGENT_MODULE_PATH = "../agent/runDemoSearchAgent.js";

export const agentRoutes = Router();

agentRoutes.post("/tasks", async (req, res, next) => {
  try {
    const request = parseCreatePersistentAgentTaskRequest(req.body);
    const snapshot = await agentRepository.createTaskWithCreatedEvent(request);

    res.json({
      success: true,
      data: {
        taskId: snapshot.task.id,
        status: snapshot.task.status,
        eventsUrl: `/api/agent/tasks/${encodeURIComponent(snapshot.task.id)}/events`
      }
    });
  } catch (error) {
    next(error);
  }
});

agentRoutes.post("/search", (req, res, next) => {
  try {
    const request = parseDemoSearchRequest(req.body);
    const userContext = getCurrentUserContext(req);
    const task = createTask({ request });

    void runSearchTaskInBackground(task.id, request, userContext);

    res.json({
      success: true,
      data: {
        taskId: task.id,
        status: "running",
        createdAt: task.createdAt
      }
    } satisfies AgentSearchTaskStartApiResponse);
  } catch (error) {
    next(error);
  }
});

agentRoutes.get("/tasks/:taskId", async (req, res, next) => {
  try {
    const taskId = req.params.taskId.trim();
    const task = getTask(taskId);

    if (task) {
      res.json({
        success: true,
        data: task
      } satisfies AgentTaskApiResponse);
      return;
    }

    if (!agentRepository.isConfigured()) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", "Agent task not found");
    }

    const snapshot = await agentRepository.getTaskSnapshot(taskId);
    if (!snapshot) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", "Agent task not found");
    }

    res.json({
      success: true,
      data: snapshot
    });
  } catch (error) {
    next(error);
  }
});

function parseCreatePersistentAgentTaskRequest(body: unknown): {
  query: string;
  metadata: Record<string, unknown>;
} {
  const record = isRecord(body) ? body : {};
  const query = readString(record.query).trim();

  if (!query) {
    throw new HttpError(400, "QUERY_REQUIRED", "Missing required body field: query");
  }

  if (record.metadata !== undefined && !isRecord(record.metadata)) {
    throw new HttpError(400, "METADATA_INVALID", "metadata must be an object");
  }

  return {
    query,
    metadata: record.metadata ?? {}
  };
}

async function runSearchTaskInBackground(
  taskId: string,
  request: DemoSearchRequest,
  userContext: UserContext
): Promise<void> {
  try {
    const runDemoSearchAgent = await loadRunDemoSearchAgent();
    const result = await runDemoSearchAgent({
      taskId,
      request,
      userContext
    });

    if (result) {
      completeTask(taskId, result);
    }
  } catch (error) {
    failTask(taskId, error);
  }
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadRunDemoSearchAgent(): Promise<RunDemoSearchAgent> {
  const agentModule = await import(RUN_DEMO_SEARCH_AGENT_MODULE_PATH) as {
    runDemoSearchAgent?: RunDemoSearchAgent;
  };

  if (typeof agentModule.runDemoSearchAgent !== "function") {
    throw new Error("runDemoSearchAgent export is missing");
  }

  return agentModule.runDemoSearchAgent;
}
