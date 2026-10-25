// Internal media worker for the 流光 player. Reachable only on the Docker
// network and only with the shared internal secret. It does two jobs:
//
//   1. Remux: containers browsers cannot play (MKV, FLV, AVI, TS…) are
//      repackaged to HLS with `ffmpeg -c:v copy` — the video stream is not
//      re-encoded, so a 2-core server keeps up easily. Audio that browsers
//      cannot decode (AC3, DTS, FLAC…) is converted to AAC, which is cheap.
//   2. BitTorrent: magnet links and .torrent files are streamed while they
//      download. Only the pieces the player asks for are fetched first.
//
// Downloaded data is temporary and deleted when idle or over the disk cap.

import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || "/data";
const REMUX_DIR = path.join(DATA_DIR, "remux");
const TORRENT_DIR = path.join(DATA_DIR, "torrents");
const MAX_BYTES = Number(process.env.MEDIA_MAX_GB || 8) * 1024 ** 3;
const BT_ENABLED = process.env.BT_ENABLED !== "false";
const TORRENT_PORT = Number(process.env.TORRENT_PORT || 6881);
// BitTorrent always uploads to the peers it downloads from; this caps it.
const UPLOAD_LIMIT = Number(process.env.BT_UPLOAD_LIMIT_KB || 200) * 1024;
const TORRENT_IDLE_MS = Number(process.env.TORRENT_IDLE_MIN || 30) * 60_000;
const REMUX_IDLE_MS = Number(process.env.REMUX_IDLE_HOURS || 6) * 3_600_000;
// Finding peers for a magnet can take minutes. Each request waits a short
// while and otherwise reports "still searching"; the search itself keeps
// going in the background until this deadline.
const METADATA_TIMEOUT_MS = 180_000;
const METADATA_WAIT_MS = 20_000;
// Updated once the server listens, so remuxing a torrent reads from whatever
// port this process actually got.
let selfUrl = `http://127.0.0.1:${PORT}`;

export const INTERNAL_SECRET =
  process.env.INTERNAL_SECRET ||
  (process.env.APP_SECRET
    ? createHmac("sha256", process.env.APP_SECRET).update("liuguang-internal").digest("hex")
    : "");

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv|avi|flv|ts|m2ts|mts|wmv|mpg|mpeg|rmvb|rm|3gp)$/i;
const DIRECT_EXTENSIONS = /\.(mp4|m4v|mov|webm)$/i;
const CONTENT_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".ts": "video/mp2t",
};

function log(msg, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...fields }));
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ── remux ──────────────────────────────────────────────────────────────────

/** @type {Map<string, {id: string, dir: string, status: string, error?: string, lastAccess: number, proc?: import("node:child_process").ChildProcess}>} */
const remuxJobs = new Map();

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `exit ${code}`));
    });
  });
}

function headerArgs(headers) {
  const lines = Object.entries(headers || {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  return lines ? ["-headers", lines] : [];
}

async function probe(input, headers) {
  let output;
  try {
    output = await run(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_streams", ...headerArgs(headers), "-i", input],
      45_000,
    );
  } catch (error) {
    log("ffprobe failed", { error: error.message });
    throw new HttpError(502, "PROBE_FAILED", "无法读取视频信息，文件可能损坏或无法访问。");
  }
  const streams = JSON.parse(output).streams || [];
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video) throw new HttpError(422, "NO_VIDEO", "文件里没有视频画面。");
  if (!["h264", "hevc"].includes(video.codec_name)) {
    throw new HttpError(
      422,
      "UNSUPPORTED_CODEC",
      `视频编码为 ${video.codec_name}，浏览器无法直接播放，需要重新压缩，服务器性能不足以实时处理。`,
    );
  }
  return { video, audio };
}

async function startRemux(key, input, headers) {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
  const existing = remuxJobs.get(id);
  if (existing && existing.status !== "failed") {
    existing.lastAccess = Date.now();
    return existing;
  }
  await ensureSpace();
  const { video, audio } = await probe(input, headers);
  const dir = path.join(REMUX_DIR, id);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const audioArgs = !audio
    ? []
    : audio.codec_name === "aac"
      ? ["-c:a", "copy"]
      : ["-c:a", "aac", "-b:a", "160k", "-ac", "2"];
  const args = [
    "-nostdin", "-loglevel", "error",
    ...headerArgs(headers),
    "-i", input,
    "-map", "0:v:0", ...(audio ? ["-map", "0:a:0"] : []),
    "-c:v", "copy", ...(video.codec_name === "hevc" ? ["-tag:v", "hvc1"] : []),
    ...audioArgs,
    "-f", "hls",
    "-hls_time", "6",
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_flags", "independent_segments+temp_file",
    "-hls_segment_filename", path.join(dir, "seg%05d.m4s"),
    path.join(dir, "index.m3u8"),
  ];
  const job = { id, dir, status: "running", lastAccess: Date.now() };
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  proc.on("close", (code) => {
    job.proc = undefined;
    if (code === 0) {
      job.status = "done";
    } else if (job.status !== "stopped") {
      job.status = "failed";
      job.error = stderr.trim().split("\n").pop();
      log("remux failed", { id, code, error: job.error });
    }
  });
  job.proc = proc;
  remuxJobs.set(id, job);
  log("remux started", { id, video: video.codec_name, audio: audio?.codec_name });
  return job;
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.stat(file);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  return null;
}

async function serveRemuxFile(req, res, id, name) {
  if (!/^[0-9a-f]{24}$/.test(id) || !/^(index\.m3u8|init\.mp4|seg\d{5}\.m4s)$/.test(name)) {
    throw new HttpError(404, "NOT_FOUND", "not found");
  }
  const job = remuxJobs.get(id);
  if (!job) throw new HttpError(404, "REMUX_GONE", "转换任务已过期，请重新解析。");
  job.lastAccess = Date.now();
  const file = path.join(job.dir, name);
  const stat = await waitForFile(file, name === "index.m3u8" ? 30_000 : 15_000);
  if (!stat) {
    if (job.status === "failed") throw new HttpError(502, "REMUX_FAILED", "视频转换失败。");
    throw new HttpError(504, "REMUX_SLOW", "视频转换中，请稍候重试。");
  }
  const type = name.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : "video/mp4";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Cache-Control": name.endsWith(".m3u8") ? "no-store" : "private, max-age=3600",
  });
  if (req.method === "HEAD") return res.end();
  await pipeline(createReadStream(file), res);
}

// ── BitTorrent ─────────────────────────────────────────────────────────────

let torrentClient = null;
/** @type {Map<string, number>} infoHash → last access */
const torrentAccess = new Map();

async function client() {
  if (!BT_ENABLED) throw new HttpError(503, "BT_DISABLED", "BT 功能未开启（BT_ENABLED=false）。");
  if (!torrentClient) {
    const { default: WebTorrent } = await import("webtorrent");
    torrentClient = new WebTorrent({
      torrentPort: TORRENT_PORT,
      uploadLimit: UPLOAD_LIMIT,
      lsd: false,
      natUpnp: false,
      natPmp: false,
    });
    torrentClient.on("error", (error) => log("torrent client error", { error: error.message }));
  }
  return torrentClient;
}

function fileKind(name) {
  if (DIRECT_EXTENSIONS.test(name)) return "direct";
  if (VIDEO_EXTENSIONS.test(name)) return "remux";
  return null;
}

function describe(torrent) {
  return {
    infoHash: torrent.infoHash,
    name: torrent.name,
    files: torrent.files.map((file, index) => ({
      index,
      name: file.path,
      length: file.length,
      kind: fileKind(file.name),
    })),
  };
}

/** @type {Map<object, number>} torrents still looking for metadata → when added */
const pendingSince = new Map();

function waitReady(torrent, ms) {
  return new Promise((resolve, reject) => {
    if (torrent.ready) return resolve(true);
    const cleanup = () => {
      clearTimeout(timer);
      torrent.off("ready", onReady);
      torrent.off("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve(true);
    };
    const onError = (error) => {
      cleanup();
      reject(new HttpError(400, "BAD_TORRENT", `种子无效：${error.message}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);
    torrent.once("ready", onReady);
    torrent.once("error", onError);
  });
}

async function dropPending(torrent) {
  pendingSince.delete(torrent);
  await new Promise((resolve) => torrent.destroy({ destroyStore: true }, resolve));
}

async function addTorrent({ magnet, torrentBase64, waitMs = METADATA_WAIT_MS }) {
  const bt = await client();
  const torrentId = magnet || Buffer.from(String(torrentBase64 || ""), "base64");
  if (!magnet && !torrentId.length) throw new HttpError(400, "BAD_REQUEST", "缺少磁力链接或种子文件。");
  const existing = await bt.get(torrentId).catch(() => null);
  if (existing?.ready) {
    torrentAccess.set(existing.infoHash, Date.now());
    return describe(existing);
  }
  let torrent = existing;
  if (!torrent) {
    await ensureSpace();
    torrent = bt.add(torrentId, {
      path: TORRENT_DIR,
      deselect: true,
      destroyStoreOnDestroy: true,
    });
    // Without a listener, a later torrent error would crash the whole worker.
    torrent.on("error", (error) => log("torrent error", { error: error.message }));
    pendingSince.set(torrent, Date.now());
  }
  const ready = await waitReady(torrent, Math.min(Number(waitMs) || METADATA_WAIT_MS, METADATA_TIMEOUT_MS))
    .catch(async (error) => {
      await dropPending(torrent);
      throw error;
    });
  if (!ready) {
    const since = pendingSince.get(torrent) ?? Date.now();
    if (Date.now() - since < METADATA_TIMEOUT_MS) {
      return { pending: true, peers: torrent.numPeers };
    }
    await dropPending(torrent);
    throw new HttpError(504, "METADATA_TIMEOUT", "找不到下载源：暂时没有人在分享这个资源，请换一个链接或稍后再试。");
  }
  pendingSince.delete(torrent);
  torrentAccess.set(torrent.infoHash, Date.now());
  log("torrent ready", { infoHash: torrent.infoHash, files: torrent.files.length });
  return describe(torrent);
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    start = Math.max(size - Number(match[2]), 0);
    end = size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

async function serveTorrentFile(req, res, infoHash, index) {
  const bt = await client();
  const torrent = /^[0-9a-f]{40}$/.test(infoHash) ? await bt.get(infoHash) : null;
  const file = torrent?.ready ? torrent.files[Number(index)] : undefined;
  if (!file) throw new HttpError(404, "TORRENT_GONE", "种子已过期，请重新解析。");
  torrentAccess.set(infoHash, Date.now());

  const size = file.length;
  const range = parseRange(req.headers.range, size);
  const type = CONTENT_TYPES[path.extname(file.name).toLowerCase()] || "application/octet-stream";
  if (range === "invalid") {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  const { start, end } = range || { start: 0, end: size - 1 };
  res.writeHead(range ? 206 : 200, {
    "Content-Type": type,
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  });
  // Send headers now: the first piece can take a while to arrive from peers,
  // and the app only waits a limited time for headers.
  res.flushHeaders();
  if (req.method === "HEAD") return res.end();
  const stream = file.createReadStream({ start, end });
  res.on("close", () => stream.destroy());
  await pipeline(stream, res).catch(() => {
    // The player closed the connection (seek or stop); nothing to report.
  });
}

// ── disk housekeeping ──────────────────────────────────────────────────────

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function removeRemux(job) {
  job.status = "stopped";
  job.proc?.kill("SIGKILL");
  remuxJobs.delete(job.id);
  await fs.rm(job.dir, { recursive: true, force: true });
}

async function removeTorrent(infoHash) {
  torrentAccess.delete(infoHash);
  const torrent = torrentClient && (await torrentClient.get(infoHash));
  if (torrent) await new Promise((resolve) => torrent.destroy({ destroyStore: true }, resolve));
}

/** Frees space by dropping the least recently used items until under the cap. */
async function ensureSpace() {
  let used = await dirSize(DATA_DIR);
  if (used < MAX_BYTES * 0.9) return;
  const items = [
    ...[...remuxJobs.values()].map((job) => ({ at: job.lastAccess, drop: () => removeRemux(job) })),
    ...[...torrentAccess].map(([hash, at]) => ({ at, drop: () => removeTorrent(hash) })),
  ].sort((a, b) => a.at - b.at);
  for (const item of items) {
    if (used < MAX_BYTES * 0.7) break;
    await item.drop();
    used = await dirSize(DATA_DIR);
  }
  log("disk cleanup", { usedMB: Math.round(used / 1024 ** 2) });
}

async function sweepIdle() {
  const now = Date.now();
  for (const job of [...remuxJobs.values()]) {
    if (now - job.lastAccess > REMUX_IDLE_MS) await removeRemux(job);
  }
  for (const [hash, at] of [...torrentAccess]) {
    if (now - at > TORRENT_IDLE_MS) await removeTorrent(hash);
  }
  // Searches nobody polls any more (the page was closed).
  for (const [torrent, since] of [...pendingSince]) {
    if (now - since > METADATA_TIMEOUT_MS) await dropPending(torrent);
  }
  await ensureSpace();
}

// ── HTTP ───────────────────────────────────────────────────────────────────

function authorized(req) {
  const received = Buffer.from(String(req.headers["x-internal-secret"] || ""));
  const expected = Buffer.from(INTERNAL_SECRET);
  return expected.length > 0 && received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8 * 1024 * 1024) throw new HttpError(413, "TOO_LARGE", "请求过大。");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "无效的请求。");
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export async function handle(req, res) {
  const url = new URL(req.url, selfUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/health") return sendJson(res, 200, { ok: true, bt: BT_ENABLED });
  if (!authorized(req)) return sendJson(res, 403, { code: "FORBIDDEN", error: "forbidden" });

  if (req.method === "POST" && url.pathname === "/remux") {
    const { key, input, headers } = await readJson(req);
    if (typeof key !== "string" || typeof input !== "string" || !/^https?:\/\//.test(input)) {
      throw new HttpError(400, "BAD_REQUEST", "无效的转换请求。");
    }
    const job = await startRemux(key, input, headers);
    return sendJson(res, 200, { id: job.id, status: job.status });
  }
  if (req.method === "POST" && url.pathname === "/remux-torrent") {
    const { infoHash, index } = await readJson(req);
    const input = `${selfUrl}/torrent/${infoHash}/${Number(index)}`;
    const job = await startRemux(`bt:${infoHash}:${index}`, input, {
      "x-internal-secret": INTERNAL_SECRET,
    });
    return sendJson(res, 200, { id: job.id, status: job.status });
  }
  if (["GET", "HEAD"].includes(req.method) && parts[0] === "remux" && parts.length === 3) {
    return serveRemuxFile(req, res, parts[1], parts[2]);
  }
  if (req.method === "POST" && url.pathname === "/torrent") {
    return sendJson(res, 200, await addTorrent(await readJson(req)));
  }
  if (["GET", "HEAD"].includes(req.method) && parts[0] === "torrent" && parts.length === 3) {
    return serveTorrentFile(req, res, parts[1], parts[2]);
  }
  throw new HttpError(404, "NOT_FOUND", "not found");
}

export function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) log("request failed", { path: req.url, error: error.message });
      if (res.headersSent) return res.destroy();
      sendJson(res, status, {
        code: error.code || "INTERNAL",
        error: error instanceof HttpError ? error.message : "媒体服务出错。",
      });
    });
  });
  server.on("listening", () => {
    selfUrl = `http://127.0.0.1:${server.address().port}`;
  });
  return server;
}

export async function shutdown() {
  for (const job of remuxJobs.values()) job.proc?.kill("SIGKILL");
  if (torrentClient) await new Promise((resolve) => torrentClient.destroy(resolve));
  torrentClient = null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!INTERNAL_SECRET) {
    console.error("APP_SECRET (or INTERNAL_SECRET) is required");
    process.exit(1);
  }
  await fs.mkdir(REMUX_DIR, { recursive: true });
  await fs.mkdir(TORRENT_DIR, { recursive: true });
  // Nothing survives a restart: in-memory job tables are empty, so old files
  // would be orphans.
  for (const dir of [REMUX_DIR, TORRENT_DIR]) {
    for (const entry of await fs.readdir(dir)) await fs.rm(path.join(dir, entry), { recursive: true, force: true });
  }
  setInterval(() => sweepIdle().catch((error) => log("sweep failed", { error: error.message })), 5 * 60_000).unref();
  createServer().listen(PORT, () => log("media worker listening", { port: PORT, bt: BT_ENABLED, maxGB: MAX_BYTES / 1024 ** 3 }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown().finally(() => process.exit(0)));
}
