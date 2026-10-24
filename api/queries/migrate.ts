import path from "path";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { log } from "../lib/logger";
import { getDb } from "./connection";

// Applies db/migrations on startup so a fresh deployment needs no separate
// drizzle-kit step (drizzle-kit is a dev dependency and absent from the image).
// The database container may still be starting, so retry for about a minute.
export async function runMigrations(): Promise<void> {
  const migrationsFolder =
    process.env.MIGRATIONS_DIR ||
    path.resolve(import.meta.dirname, "../db/migrations");
  for (let attempt = 1; ; attempt += 1) {
    try {
      await migrate(getDb(), { migrationsFolder });
      log.info("database migrations applied", { migrationsFolder });
      return;
    } catch (error) {
      if (attempt >= 30) throw error;
      log.warn("database not ready, retrying migrations", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
