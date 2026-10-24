import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { log } from "./lib/logger";

export class RouteError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    message: string,
    public code = "REQUEST_FAILED",
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function routeErrorResponse(c: Context, error: unknown) {
  if (error instanceof RouteError) {
    if (error.retryAfterSeconds) {
      c.header("Retry-After", String(error.retryAfterSeconds));
    }
    return c.json(
      { error: error.message, code: error.code },
      error.status,
    );
  }

  log.error("route failed", {
    path: c.req.path,
    error: error instanceof Error ? error.message : String(error),
  });
  return c.json(
    { error: "服务暂时不可用，请稍后重试。", code: "INTERNAL_ERROR" },
    500,
  );
}

// X-Forwarded-For is client-controlled, so it is only honoured when a reverse
// proxy sits in front. Otherwise any caller could rotate it to dodge the login
// lockout and rate limits. The LAST hop is used: it is the address our own
// proxy saw, whether that proxy overwrites the header (Caddy) or appends to a
// client-supplied one (Go's ReverseProxy, used by Tailscale serve).
export function clientIp(c: Context): string {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) return forwarded.split(",").at(-1)!.trim().slice(0, 80);
    const realIp = c.req.header("x-real-ip");
    if (realIp) return realIp.slice(0, 80);
  }
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  return (env?.incoming?.socket?.remoteAddress || "local").slice(0, 80);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function secretsEqual(received: string, expected: string): boolean {
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

type Bucket = { startedAt: number; count: number };
const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): void {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    buckets.set(key, { startedAt: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((current.startedAt + windowMs - now) / 1000),
      );
      throw new RouteError(
        429,
        "请求过于频繁，请稍后再试。",
        "RATE_LIMITED",
        retryAfterSeconds,
      );
    }
  }

  if (buckets.size > 5000) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.startedAt > 60 * 60 * 1000) buckets.delete(bucketKey);
    }
  }
}
