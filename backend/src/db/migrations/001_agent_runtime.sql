CREATE TABLE IF NOT EXISTS agent_tasks (
  id text PRIMARY KEY,
  user_id text,
  query text NOT NULL,
  status text NOT NULL,
  current_stage text,
  progress integer NOT NULL DEFAULT 0,
  result_artifact_id text,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz
);

CREATE TABLE IF NOT EXISTS agent_stage_runs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  stage_name text NOT NULL,
  status text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  timeout_ms integer,
  input_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  fallback_used boolean NOT NULL DEFAULT false,
  fallback_reason text,
  error text,
  started_at timestamptz,
  ended_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_events (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_created_at
  ON agent_tasks(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_stage_runs_task_id_created_at
  ON agent_stage_runs(task_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_agent_artifacts_task_id_created_at
  ON agent_artifacts(task_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_agent_events_task_id_created_at
  ON agent_events(task_id, created_at ASC);

