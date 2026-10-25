import { createHmac } from "node:crypto";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { env } from "./lib/env";
import { RouteError } from "./routeUtils";

// Client for the internal media worker (media/): ffmpeg remuxing and
// BitTorrent streaming. Both sides derive the same secret from APP_SECRET.

export function internalSecret(): string {
  return createHmac("sha256", env.appSecret || "development-only-media-token-secret")
    .update("liuguang-internal")
    .digest("hex");
}

function mediaUrl(): string {
  const url = process.env.MEDIA_URL?.trim();
  if (!url) {
    throw new RouteError(
      503,
      "媒体服务未启用：MKV／FLV／AVI 转换和 BT 播放需要 media 服务。",
      "MEDIA_DISABLED",
    );
  }
  return url.replace(/\/$/, "");
}

/** Where the worker can reach this app (for remuxing a proxied source). */
export function appInternalUrl(): string {
  return (process.env.APP_INTERNAL_URL?.trim() || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
}

async function workerFetch(
  path: string,
  init: RequestInit & { timeoutMs: number; streamBody?: boolean },
): Promise<Response> {
  const { timeoutMs, streamBody, headers, ...rest } = init;
  // For streamed bodies only the wait for headers is timed: a long video
  // keeps the response open far longer than any fixed timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(`${mediaUrl()}${path}`, {
      ...rest,
      headers: { ...(headers as Record<string, string>), "x-internal-secret": internalSecret() },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(502, "无法连接媒体服务，请稍后重试。", "MEDIA_UNREACHABLE");
  } finally {
    if (streamBody) clearTimeout(timer);
  }
}

export async function workerJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const response = await workerFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    throw new RouteError(
      response.status as ContentfulStatusCode,
      data.error || "媒体服务处理失败。",
      data.code || "MEDIA_FAILED",
    );
  }
  return data as T;
}

const FORWARDED = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
];

/** Streams a remuxed segment or a torrent file from the worker to the browser. */
export async function proxyWorkerStream(
  path: string,
  range: string | undefined,
  method: "GET" | "HEAD",
): Promise<Response> {
  const response = await workerFetch(path, {
    method,
    headers: range && range.length < 120 ? { Range: range } : {},
    // Playlist requests may wait for ffmpeg's first segments; segments and
    // torrent pieces may wait for peers. The body itself streams untimed.
    timeoutMs: 60_000,
    streamBody: true,
  });
  if (!response.ok && response.status !== 206) {
    const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new RouteError(
      response.status as ContentfulStatusCode,
      data.error || "媒体服务处理失败。",
      data.code || "MEDIA_FAILED",
    );
  }
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    headers,
  });
}
