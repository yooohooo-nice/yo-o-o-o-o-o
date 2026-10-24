import {
  index,
  int,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const accessSessions = mysqlTable(
  "access_sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => ({
    expiresAtIdx: index("access_sessions_expires_at_idx").on(table.expiresAt),
  }),
);

export const accessAttempts = mysqlTable("access_attempts", {
  ipHash: varchar("ip_hash", { length: 64 }).primaryKey(),
  failedCount: int("failed_count").default(0).notNull(),
  windowStartedAt: timestamp("window_started_at").defaultNow().notNull(),
  lockedUntil: timestamp("locked_until"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AccessSession = typeof accessSessions.$inferSelect;
export type AccessAttempt = typeof accessAttempts.$inferSelect;
