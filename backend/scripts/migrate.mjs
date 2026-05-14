import dotenv from "dotenv";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = resolve(backendDir, "..");

dotenv.config({ path: resolve(rootDir, ".env.local"), override: false });
dotenv.config({ path: resolve(backendDir, ".env.local"), override: false });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to run database migrations.");
  process.exit(1);
}

const migrationsDir = resolve(backendDir, "src/db/migrations");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

try {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = await readFile(resolve(migrationsDir, file), "utf8");
    console.log(`Running migration ${file}`);
    await pool.query(sql);
  }

  console.log(`Applied ${files.length} migration(s).`);
} catch (error) {
  console.error("Database migration failed.");
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
