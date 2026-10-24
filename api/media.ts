import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { load } from "cheerio";
import ipaddr from "ipaddr.js";
import type { MediaKind, ResolveMediaResult } from "@contracts/types";
import { env } from "./lib/env";
import { RouteError } from "./routeUtils";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_URL_LENGTH = 4096;

const JABLE_HOSTS = ["jable.tv", "fs1.app"] as const;
const MISSAV_HOSTS = [
  "missav.ai",
  "missav.ws",
  "missav123.com",
  "missav.live",
] as const;

type TokenKind = "auto" | "mp4" | "poster";
type MediaHeaders = Record<string, string>;
type MediaTokenPayload = {
  v: 1;
  url: string;
  kind: TokenKind;
  headers?: MediaHeaders;
  exp: number;
};

type FetchOptions = {
  method?: string;
  headers?: MediaHeaders;
  timeoutMs?: number;
};

function tokenSecret(): string {
  return env.appSecret || "development-only-media-token-secret";
}

function sign(value: string): Buffer {
  return createHmac("sha256", tokenSecret()).update(value).digest();
}

function createMediaToken(
  url: string,
  kind: TokenKind,
  headers?: MediaHeaders,
  expiresAt = Date.now() + TOKEN_TTL_MS,
): string {
  const payload: MediaTokenPayload = {
    v: 1,
    url,
    kind,
    headers,
    exp: expiresAt,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(body).toString("base64url");
  return `${body}.${signature}`;
}

export function verifyMediaToken(token: string): MediaTokenPayload {
  try {
    if (!token || token.length > 12000) throw new Error("invalid length");
    const [body, signature] = token.split(".");
    if (!body || !signature) throw new Error("invalid token");
    const expected = sign(body);
    const received = Buffer.from(signature, "base64url");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error("invalid signature");
    }
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as MediaTokenPayload;
    if (
      payload.v !== 1 ||
      !payload.url ||
      payload.url.length > MAX_URL_LENGTH ||
      !["auto", "mp4", "poster"].includes(payload.kind) ||
      !Number.isFinite(payload.exp)
    ) {
      throw new Error("invalid payload");
    }
    if (payload.exp <= Date.now()) {
      throw new RouteError(401, "播放地址已过期，请重新解析。", "MEDIA_EXPIRED");
    }
    return payload;
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(403, "播放地址无效，请重新解析。", "INVALID_MEDIA_TOKEN");
  }
}

function isPublicIp(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) {
        return ipv6.toIPv4Address().range() === "unicast";
      }
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export async function assertPublicUrl(value: string | URL): Promise<URL> {
  const url = typeof value === "string" ? new URL(value) : value;
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new RouteError(400, "仅支持 HTTP／HTTPS 媒体地址。", "INVALID_MEDIA_URL");
  }
  if (url.username || url.password || url.href.length > MAX_URL_LENGTH) {
    throw new RouteError(400, "媒体地址不符合要求。", "INVALID_MEDIA_URL");
  }
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!["80", "443"].includes(port)) {
    throw new RouteError(400, "媒体地址端口不受支持。", "INVALID_MEDIA_URL");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new RouteError(403, "媒体地址不可访问。", "PRIVATE_MEDIA_URL");
  }

  if (ipaddr.isValid(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new RouteError(403, "媒体地址不可访问。", "PRIVATE_MEDIA_URL");
    }
    return url;
  }

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
      throw new RouteError(403, "媒体地址不可访问。", "PRIVATE_MEDIA_URL");
    }
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(502, "无法解析媒体服务器地址。", "DNS_FAILED");
  }
  return url;
}

async function fetchPublic(
  initialUrl: string,
  options: FetchOptions = {},
): Promise<{ response: Response; finalUrl: URL }> {
  let current = new URL(initialUrl);
  for (let redirect = 0; redirect < 5; redirect += 1) {
    current = await assertPublicUrl(current);
    let response: Response;
    try {
      response = await fetch(current, {
        method: options.method || "GET",
        headers: options.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs || 20_000),
      });
    } catch {
      throw new RouteError(502, "无法连接源站或媒体服务器。", "UPSTREAM_UNREACHABLE");
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return { response, finalUrl: current };
      await response.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new RouteError(502, "媒体服务器重定向次数过多。", "TOO_MANY_REDIRECTS");
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RouteError(413, "源站响应过大。", "UPSTREAM_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(502, "读取源站响应失败。", "UPSTREAM_READ_FAILED");
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function pageHeaders(host: string): MediaHeaders {
  return {
    "User-Agent": BROWSER_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: `https://${host}/`,
  };
}

function mediaHeaders(host?: string, includeOrigin = false): MediaHeaders {
  const headers: MediaHeaders = { "User-Agent": BROWSER_UA };
  if (host) headers.Referer = `https://${host}/`;
  if (host && includeOrigin) headers.Origin = `https://${host}`;
  return headers;
}

function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function candidateUrls(input: URL, hosts: readonly string[]): URL[] {
  const candidates = [input.href];
  for (const host of hosts) {
    const mirror = new URL(input.href);
    mirror.hostname = host;
    mirror.protocol = "https:";
    mirror.port = "";
    if (!candidates.includes(mirror.href)) candidates.push(mirror.href);
  }
  return candidates.map((href) => new URL(href));
}

function findDirectM3u8(html: string): string | null {
  return html.match(/https:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/)?.[0] || null;
}

function toBase(value: number, base: number): string {
  const digits = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (value === 0) return "0";
  let result = "";
  let current = value;
  while (current > 0) {
    result = digits[current % base] + result;
    current = Math.floor(current / base);
  }
  return result;
}

// Adapted from FetchJAV's SiteMissAV._unpack_js_eval (Apache-2.0).
function unpackEval(script: string): string | null {
  const match = script.match(
    /eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.*?)',\s*(\d+),\s*(\d+),\s*'([^']*)'\s*\.split\('\|'\)/s,
  );
  if (!match) return null;
  const [, packed, baseText, countText, keysText] = match;
  const base = Number(baseText);
  const count = Number(countText);
  if (base <= 1 || base > 36 || count < 0 || count > 200_000) return null;
  const keys = keysText.split("|");
  const lookupTable = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    const key = toBase(index, base);
    lookupTable.set(key, keys[index] || key);
  }
  return packed.replace(/\b(\w+)\b/g, (word) => lookupTable.get(word) || word);
}

function parseMissAvPlaylist(html: string): string | null {
  const $ = load(html);
  const scripts = $("script")
    .map((_, element) => $(element).html() || "")
    .get();
  for (const script of scripts) {
    if (!script.includes("eval(function") || !script.includes("m3u8")) continue;
    const unpacked = unpackEval(script);
    if (!unpacked) continue;
    const main = unpacked.match(/source\s*=\s*[\\']*(https?:\/\/[^'\\;\s]+\.m3u8)/);
    if (main) return main[1];
    const fallback = unpacked.match(/(https?:\/\/[^'\\;\s]+\.m3u8)/);
    if (fallback) return fallback[1];
  }
  return findDirectM3u8(html);
}

function parsePage(html: string, site: "jable" | "missav") {
  const $ = load(html);
  const title =
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='og:title']").attr("content") ||
    $("title").first().text().trim();
  const poster =
    $("meta[property='og:image']").attr("content") ||
    $("meta[name='og:image']").attr("content") ||
    null;
  const playlist = site === "jable" ? findDirectM3u8(html) : parseMissAvPlaylist(html);
  if (!title || !playlist) return null;
  return { title: title.trim(), poster, playlist };
}

function resultForResolvedPage(input: {
  sourceUrl: string;
  site: "jable" | "missav";
  finalHost: string;
  title: string;
  poster: string | null;
  playlist: string;
}): ResolveMediaResult {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const headers = mediaHeaders(input.finalHost, input.site === "missav");
  const streamToken = createMediaToken(input.playlist, "auto", headers, expiresAt);
  const posterToken = input.poster
    ? createMediaToken(input.poster, "poster", headers, expiresAt)
    : null;
  return {
    title: input.title,
    sourceUrl: input.sourceUrl,
    site: input.site,
    kind: "hls",
    streamUrl: `/api/media/stream?token=${encodeURIComponent(streamToken)}`,
    posterUrl: posterToken
      ? `/api/media/poster?token=${encodeURIComponent(posterToken)}`
      : null,
    expiresAt,
    experimental: true,
  };
}

async function resolveSitePage(
  input: URL,
  site: "jable" | "missav",
): Promise<ResolveMediaResult> {
  const hosts = site === "jable" ? JABLE_HOSTS : MISSAV_HOSTS;
  const candidates = candidateUrls(input, hosts);
  for (const candidate of candidates) {
    try {
      const host = canonicalHost(candidate.hostname);
      const { response } = await fetchPublic(candidate.href, {
        headers: pageHeaders(host),
        timeoutMs: 10_000,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        continue;
      }
      const html = await readLimited(response, MAX_PAGE_BYTES);
      if (/just a moment|cf-browser-verification|cf_chl_/i.test(html)) continue;
      const parsed = parsePage(html, site);
      if (!parsed) continue;
      return resultForResolvedPage({
        sourceUrl: input.href,
        site,
        finalHost: host,
        ...parsed,
      });
    } catch {
      // Try the next official mirror. A single final error avoids leaking
      // source-page URLs and upstream implementation details to the browser.
    }
  }
  throw new RouteError(
    502,
    "暂时无法从源站解析。可能是源站限制、页面失效或服务器网络问题；可稍后重试，或先用播放自检确认播放器正常。",
    "SITE_RESOLVE_FAILED",
  );
}

function directTitle(url: URL): string {
  const rawSegment = url.pathname.split("/").filter(Boolean).pop() || "直链视频";
  let segment = rawSegment;
  try {
    segment = decodeURIComponent(rawSegment);
  } catch {
    // Keep the readable raw path segment when its percent-encoding is malformed.
  }
  return segment.replace(/\.(m3u8|mp4)$/i, "") || "直链视频";
}

export async function resolveMedia(rawUrl: string): Promise<ResolveMediaResult> {
  let input: URL;
  try {
    input = new URL(rawUrl.trim());
  } catch {
    throw new RouteError(400, "请输入完整、有效的视频地址。", "INVALID_URL");
  }
  if (!["http:", "https:"].includes(input.protocol) || input.username || input.password) {
    throw new RouteError(400, "请输入有效的 HTTP／HTTPS 地址。", "INVALID_URL");
  }

  const pathname = input.pathname.toLowerCase();
  if (pathname.endsWith(".m3u8") || pathname.endsWith(".mp4")) {
    await assertPublicUrl(input);
    const kind: MediaKind = pathname.endsWith(".mp4") ? "mp4" : "hls";
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const token = createMediaToken(
      input.href,
      kind === "mp4" ? "mp4" : "auto",
      mediaHeaders(),
      expiresAt,
    );
    return {
      title: directTitle(input),
      sourceUrl: input.href,
      site: "direct",
      kind,
      streamUrl: `/api/media/stream?token=${encodeURIComponent(token)}`,
      posterUrl: null,
      expiresAt,
      experimental: false,
    };
  }

  const host = canonicalHost(input.hostname);
  if (JABLE_HOSTS.includes(host as (typeof JABLE_HOSTS)[number])) {
    if (!/^\/videos\/[a-zA-Z0-9_-]+\/?$/.test(input.pathname)) {
      throw new RouteError(400, "请输入 Jable 的单个视频页地址。", "INVALID_JABLE_URL");
    }
    return resolveSitePage(input, "jable");
  }
  if (MISSAV_HOSTS.includes(host as (typeof MISSAV_HOSTS)[number])) {
    const parts = input.pathname.split("/").filter(Boolean);
    if (!parts.length || parts.length > 3 || !/[0-9_-]/.test(parts.at(-1) || "")) {
      throw new RouteError(400, "请输入 MissAV 的单个视频页地址。", "INVALID_MISSAV_URL");
    }
    return resolveSitePage(input, "missav");
  }

  throw new RouteError(
    400,
    "目前支持 Jable、MissAV 视频页，以及 .m3u8／.mp4 直链。",
    "UNSUPPORTED_SITE",
  );
}

function rewritePlaylist(
  text: string,
  baseUrl: URL,
  payload: MediaTokenPayload,
): string {
  const proxyUrl = (target: string): string => {
    const absolute = new URL(target, baseUrl).href;
    const token = createMediaToken(
      absolute,
      "auto",
      payload.headers,
      payload.exp,
    );
    return `/api/media/stream?token=${encodeURIComponent(token)}`;
  };
  const rewritable = (value: string) =>
    value && !/^(data|skd|urn):/i.test(value);

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI=(["'])(.*?)\1/g, (whole, quote, uri) => {
          if (!rewritable(uri)) return whole;
          return `URI=${quote}${proxyUrl(uri)}${quote}`;
        });
      }
      return rewritable(trimmed) ? proxyUrl(trimmed) : line;
    })
    .join("\n");
}

function isPlaylist(url: URL, contentType: string, prefix?: Uint8Array): boolean {
  if (
    url.pathname.toLowerCase().endsWith(".m3u8") ||
    /mpegurl|vnd\.apple/i.test(contentType)
  ) {
    return true;
  }
  if (!prefix) return false;
  const text = Buffer.from(prefix).toString("utf8").trimStart();
  return text.startsWith("#EXTM3U");
}

function forwardedHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "private, max-age=300");
  return headers;
}

async function playlistResponse(
  response: Response,
  finalUrl: URL,
  payload: MediaTokenPayload,
  firstChunk?: Uint8Array,
  reader?: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Response> {
  let text: string;
  if (reader) {
    const chunks: Uint8Array[] = firstChunk ? [firstChunk] : [];
    let total = firstChunk?.byteLength || 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_PLAYLIST_BYTES) {
        await reader.cancel();
        throw new RouteError(413, "播放列表过大。", "PLAYLIST_TOO_LARGE");
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  } else {
    text = await readLimited(response, MAX_PLAYLIST_BYTES);
  }
  const rewritten = rewritePlaylist(text, finalUrl, payload);
  return new Response(rewritten, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function proxyMedia(
  token: string,
  range: string | undefined,
  method: "GET" | "HEAD",
): Promise<Response> {
  const payload = verifyMediaToken(token);
  const headers = { ...(payload.headers || {}) };
  const isPlaylistTarget = payload.kind === "auto" &&
    new URL(payload.url).pathname.toLowerCase().endsWith(".m3u8");
  // Native HLS clients may send Range for a playlist. Always retrieve the full
  // playlist so every variant, segment, key and MAP URI can be rewritten safely.
  if (range && range.length < 120 && !isPlaylistTarget) headers.Range = range;
  const { response, finalUrl } = await fetchPublic(payload.url, {
    method,
    headers,
    timeoutMs: 30_000,
  });

  if (method === "HEAD") {
    await response.body?.cancel();
    return new Response(null, {
      status: response.status,
      headers: forwardedHeaders(response),
    });
  }
  if (response.status >= 400) {
    await response.body?.cancel();
    return new Response(null, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const contentType = response.headers.get("content-type") || "";
  if (
    payload.kind === "auto" &&
    response.status === 200 &&
    isPlaylist(finalUrl, contentType)
  ) {
    return playlistResponse(response, finalUrl, payload);
  }

  if (payload.kind === "auto" && response.status === 200 && response.body) {
    const reader = response.body.getReader();
    const { done, value } = await reader.read();
    if (done) {
      return new Response(null, { status: 200, headers: forwardedHeaders(response) });
    }
    const firstChunk = value || new Uint8Array();
    if (isPlaylist(finalUrl, contentType, firstChunk)) {
      return playlistResponse(response, finalUrl, payload, firstChunk, reader);
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (firstChunk.byteLength) controller.enqueue(firstChunk);
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (next.value) controller.enqueue(next.value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await reader.cancel();
      },
    });
    return new Response(stream, {
      status: response.status,
      headers: forwardedHeaders(response),
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: forwardedHeaders(response),
  });
}
