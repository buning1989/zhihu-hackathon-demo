import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { config } from "../config/env.js";

let pool: Pool | undefined;

export function isPostgresConfigured(): boolean {
  return Boolean(config.databaseUrl);
}

export function getPostgresPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  pool ??= new Pool({
    connectionString: config.databaseUrl
  });

  return pool;
}

export function queryPostgres<T extends QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<QueryResult<T>> {
  return getPostgresPool().query<T>(text, values);
}

