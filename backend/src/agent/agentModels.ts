export type PersistentAgentTaskStatus =
  | "queued"
  | "running"
  | "waiting_retry"
  | "completed"
  | "failed"
  | "cancelled";

export type PersistentAgentStageRunStatus =
  | "pending"
  | "running"
  | "retrying"
  | "succeeded"
  | "fallback"
  | "failed"
  | "skipped";

export interface PersistentAgentTask {
  id: string;
  userId: string | null;
  query: string;
  status: PersistentAgentTaskStatus;
  currentStage: string | null;
  progress: number;
  resultArtifactId: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
}

export interface PersistentAgentStageRun {
  id: string;
  taskId: string;
  stageName: string;
  status: PersistentAgentStageRunStatus;
  attempt: number;
  timeoutMs: number | null;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  model: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersistentAgentArtifact {
  id: string;
  taskId: string;
  type: string;
  data: unknown;
  createdAt: string;
}

export interface PersistentAgentEvent {
  id: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PersistentAgentTaskSnapshot {
  task: PersistentAgentTask;
  stages: PersistentAgentStageRun[];
  artifacts: PersistentAgentArtifact[];
  events: PersistentAgentEvent[];
}

export interface CreatePersistentAgentTaskInput {
  query: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
}

export interface UpdatePersistentAgentTaskStatusInput {
  status?: PersistentAgentTaskStatus;
  currentStage?: string | null;
  progress?: number;
  resultArtifactId?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  startedAt?: string | null;
  completedAt?: string | null;
  expiresAt?: string | null;
}

export interface CreatePersistentAgentStageRunInput {
  taskId: string;
  stageName: string;
  status?: PersistentAgentStageRunStatus;
  attempt?: number;
  timeoutMs?: number | null;
  inputArtifactIds?: string[];
  outputArtifactIds?: string[];
  model?: string | null;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  error?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
}

export interface UpdatePersistentAgentStageRunInput {
  status?: PersistentAgentStageRunStatus;
  attempt?: number;
  timeoutMs?: number | null;
  inputArtifactIds?: string[];
  outputArtifactIds?: string[];
  model?: string | null;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  error?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
}

export interface CreatePersistentAgentArtifactInput {
  taskId: string;
  type: string;
  data: unknown;
}

export interface CreatePersistentAgentEventInput {
  taskId: string;
  type: string;
  payload?: Record<string, unknown>;
}

