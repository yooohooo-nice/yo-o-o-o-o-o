import { and, desc, eq, inArray } from "drizzle-orm";
import { libraryItems, type LibraryRow } from "@db/schema";
import type { LibraryItem, LibraryResponse, MediaSite } from "@contracts/types";
import { getDb } from "./queries/connection";
import { RouteError, sha256 } from "./routeUtils";

const RECENT_LIMIT = 30;
const MAX_HISTORY = 500;

export function libraryId(url: string, fileIndex?: number | null): string {
  return sha256(`${url.trim()}|${fileIndex ?? ""}`);
}

function toItem(row: LibraryRow): LibraryItem {
  return {
    id: row.id,
    url: row.url,
    fileIndex: row.fileIndex,
    title: row.title,
    site: row.site as MediaSite,
    favorite: row.favorite,
    position: row.position,
    duration: row.duration,
    lastPlayedAt: row.lastPlayedAt.getTime(),
  };
}

/** Records that a video was opened; returns where to resume and whether it is a favorite. */
export async function recordPlay(input: {
  url: string;
  fileIndex?: number;
  title: string;
  site: MediaSite;
}): Promise<{ libraryId: string; resumeAt: number | null; favorite: boolean }> {
  const id = libraryId(input.url, input.fileIndex);
  const now = new Date();
  const title = input.title.slice(0, 500);
  await getDb()
    .insert(libraryItems)
    .values({
      id,
      url: input.url.trim(),
      fileIndex: input.fileIndex ?? null,
      title,
      site: input.site,
      lastPlayedAt: now,
    })
    .onDuplicateKeyUpdate({ set: { title, lastPlayedAt: now } });
  const [row] = await getDb().select().from(libraryItems).where(eq(libraryItems.id, id)).limit(1);
  if (Math.random() < 0.05) await pruneHistory();
  // Resuming a few seconds from the start or the very end is pointless.
  const resumeAt =
    row && row.position > 10 && (!row.duration || row.position < row.duration - 15)
      ? row.position
      : null;
  return { libraryId: id, resumeAt, favorite: row?.favorite ?? false };
}

export async function saveProgress(id: string, position: number, duration: number): Promise<void> {
  await getDb()
    .update(libraryItems)
    .set({ position: Math.round(position), duration: Math.round(duration) })
    .where(eq(libraryItems.id, id));
}

export async function setFavorite(id: string, favorite: boolean): Promise<void> {
  const [result] = await getDb()
    .update(libraryItems)
    .set({ favorite })
    .where(eq(libraryItems.id, id));
  if (!result.affectedRows) {
    throw new RouteError(404, "记录不存在。", "LIBRARY_ITEM_NOT_FOUND");
  }
}

export async function listLibrary(): Promise<LibraryResponse> {
  const db = getDb();
  const [recent, favorites] = await Promise.all([
    db.select().from(libraryItems).orderBy(desc(libraryItems.lastPlayedAt)).limit(RECENT_LIMIT),
    db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.favorite, true))
      .orderBy(desc(libraryItems.lastPlayedAt)),
  ]);
  return { recent: recent.map(toItem), favorites: favorites.map(toItem) };
}

export async function removeItem(id: string): Promise<void> {
  await getDb().delete(libraryItems).where(eq(libraryItems.id, id));
}

/** Clears watch history; favorites stay. */
export async function clearHistory(): Promise<void> {
  await getDb().delete(libraryItems).where(eq(libraryItems.favorite, false));
}

async function pruneHistory(): Promise<void> {
  const stale = await getDb()
    .select({ id: libraryItems.id })
    .from(libraryItems)
    .where(eq(libraryItems.favorite, false))
    .orderBy(desc(libraryItems.lastPlayedAt))
    .offset(MAX_HISTORY)
    .limit(1000);
  if (stale.length) {
    await getDb()
      .delete(libraryItems)
      .where(and(eq(libraryItems.favorite, false), inArray(libraryItems.id, stale.map((row) => row.id))));
  }
}
