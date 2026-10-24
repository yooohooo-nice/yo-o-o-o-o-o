import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { accessAttempts, accessSessions } from "@db/schema";
import { getDb } from "./queries/connection";
import { env } from "./lib/env";
import { RouteError, secretsEqual, sha256 } from "./routeUtils";

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const sessionCache = new Map<
  string,
  { expiresAt: number; cacheUntil: number }
>();

function ipHash(ip: string): string {
  return createHmac("sha256", env.appSecret).update(ip).digest("hex");
}

export function verifyAccessPassword(password: string): void {
  const configured = process.env.ACCESS_PASSWORD ||
    (env.isProduction ? "" : "LG-26-10-24");
  if (!configured) {
    throw new RouteError(503, "访问密码尚未配置。", "PASSWORD_NOT_CONFIGURED");
  }
  if (!secretsEqual(password, configured)) {
    throw new RouteError(401, "访问密码不正确。", "INVALID_PASSWORD");
  }
}

export async function assertLoginAllowed(ip: string): Promise<void> {
  const key = ipHash(ip);
  const [attempt] = await getDb()
    .select()
    .from(accessAttempts)
    .where(eq(accessAttempts.ipHash, key))
    .limit(1);
  if (!attempt) return;

  const now = Date.now();
  if (attempt.lockedUntil && attempt.lockedUntil.getTime() > now) {
    const retryAfterSeconds = Math.ceil(
      (attempt.lockedUntil.getTime() - now) / 1000,
    );
    throw new RouteError(
      429,
      "密码错误次数较多，请稍后再试。",
      "LOGIN_LOCKED",
      retryAfterSeconds,
    );
  }

  if (now - attempt.windowStartedAt.getTime() > ATTEMPT_WINDOW_MS) {
    await getDb()
      .update(accessAttempts)
      .set({
        failedCount: 0,
        lockedUntil: null,
        windowStartedAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(eq(accessAttempts.ipHash, key));
  }
}

export async function recordLoginFailure(ip: string): Promise<never> {
  const key = ipHash(ip);
  const now = Date.now();
  const [existing] = await getDb()
    .select()
    .from(accessAttempts)
    .where(eq(accessAttempts.ipHash, key))
    .limit(1);

  const windowExpired = !existing ||
    now - existing.windowStartedAt.getTime() > ATTEMPT_WINDOW_MS;
  const failedCount = windowExpired ? 1 : (existing?.failedCount ?? 0) + 1;
  const windowStartedAt = windowExpired || !existing
    ? new Date(now)
    : existing.windowStartedAt;
  const lockedUntil = failedCount >= MAX_FAILURES
    ? new Date(now + LOCK_DURATION_MS)
    : null;

  await getDb()
    .insert(accessAttempts)
    .values({
      ipHash: key,
      failedCount,
      windowStartedAt,
      lockedUntil,
      updatedAt: new Date(now),
    })
    .onDuplicateKeyUpdate({
      set: {
        failedCount,
        windowStartedAt,
        lockedUntil,
        updatedAt: new Date(now),
      },
    });

  if (lockedUntil) {
    throw new RouteError(
      429,
      "密码错误次数较多，已暂时锁定。",
      "LOGIN_LOCKED",
      LOCK_DURATION_MS / 1000,
    );
  }
  throw new RouteError(
    401,
    `访问密码不正确，还可尝试 ${MAX_FAILURES - failedCount} 次。`,
    "INVALID_PASSWORD",
  );
}

export async function clearLoginFailures(ip: string): Promise<void> {
  await getDb()
    .delete(accessAttempts)
    .where(eq(accessAttempts.ipHash, ipHash(ip)));
}

export async function createAccessSession(): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await getDb().insert(accessSessions).values({
    id: randomUUID(),
    tokenHash: sha256(token),
    expiresAt,
    lastSeenAt: new Date(),
  });

  if (Math.random() < 0.05) {
    await getDb()
      .delete(accessSessions)
      .where(lt(accessSessions.expiresAt, new Date()));
  }
  return { token, expiresAt };
}

export async function validateAccessSession(token?: string): Promise<boolean> {
  if (!token || token.length > 128) return false;
  const hash = sha256(token);
  const now = Date.now();
  const cached = sessionCache.get(hash);
  if (cached && cached.cacheUntil > now && cached.expiresAt > now) return true;

  const [session] = await getDb()
    .select()
    .from(accessSessions)
    .where(eq(accessSessions.tokenHash, hash))
    .limit(1);
  if (!session || session.expiresAt.getTime() <= now) {
    sessionCache.delete(hash);
    if (session) {
      await getDb().delete(accessSessions).where(eq(accessSessions.id, session.id));
    }
    return false;
  }

  sessionCache.set(hash, {
    expiresAt: session.expiresAt.getTime(),
    cacheUntil: now + 60 * 1000,
  });
  if (sessionCache.size > 2000) {
    for (const [key, value] of sessionCache) {
      if (value.cacheUntil <= now || value.expiresAt <= now) {
        sessionCache.delete(key);
      }
    }
  }
  return true;
}

export async function revokeAccessSession(token?: string): Promise<void> {
  if (!token) return;
  const hash = sha256(token);
  sessionCache.delete(hash);
  await getDb().delete(accessSessions).where(eq(accessSessions.tokenHash, hash));
}
