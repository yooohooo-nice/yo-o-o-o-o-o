import {
  boolean,
  index,
  int,
  mysqlTable,
  text,
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

// Watch history, favorites and playback position, shared by every device that
// knows the access password (the player has a single shared login).
export const libraryItems = mysqlTable(
  "library_items",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    url: text("url").notNull(),
    fileIndex: int("file_index"),
    title: varchar("title", { length: 500 }).notNull(),
    site: varchar("site", { length: 16 }).notNull(),
    favorite: boolean("favorite").default(false).notNull(),
    position: int("position").default(0).notNull(),
    duration: int("duration").default(0).notNull(),
    lastPlayedAt: timestamp("last_played_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    lastPlayedIdx: index("library_items_last_played_idx").on(table.lastPlayedAt),
  }),
);

export type AccessSession = typeof accessSessions.$inferSelect;
export type AccessAttempt = typeof accessAttempts.$inferSelect;
export type LibraryRow = typeof libraryItems.$inferSelect;
