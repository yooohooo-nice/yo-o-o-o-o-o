import type { TorrentChoice } from "@contracts/types";
import { baseName, streamFromUrl, VIDEO_NAME, type ResolvedStream } from "./media";
import { RouteError } from "./routeUtils";

// PikPak share links (mypikpak.com/s/<id>) are opened through OpenList, which
// keeps up with PikPak's unofficial API (captcha tokens, client versions).
// Each share is mounted as an OpenList "PikPakShare" storage; no PikPak
// account is needed to list a share and get its download links.

const SHARE_HOSTS = /(^|\.)mypikpak\.(com|net)$|(^|\.)pikpak\.me$/i;
const SHARE_ROOT = "/pikpak-share";
const MAX_LIST_CALLS = 40;
const MAX_FILES = 500;

export type PikPakShare = { shareId: string; password: string };

export function parsePikPakShare(input: URL): PikPakShare | null {
  if (!SHARE_HOSTS.test(input.hostname)) return null;
  const match = input.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,64})/);
  if (!match) return null;
  const password = input.searchParams.get("pwd") || input.searchParams.get("password") || "";
  return { shareId: match[1], password: password.slice(0, 64) };
}

// ── OpenList API client ────────────────────────────────────────────────────

type OpenListResponse<T> = { code: number; message: string; data: T };
type OpenListStorage = { id: number; mount_path: string; status: string; addition: string };
type OpenListObject = { name: string; size: number; is_dir: boolean };

class OpenListError extends Error {}

let token: string | null = null;

function settings() {
  const url = process.env.OPENLIST_URL?.trim();
  if (!url) {
    throw new RouteError(503, "网盘服务未启用：播放 PikPak 分享需要 openlist 服务。", "OPENLIST_DISABLED");
  }
  return {
    url: url.replace(/\/$/, ""),
    username: process.env.OPENLIST_USERNAME || "admin",
    password: process.env.OPENLIST_PASSWORD || "",
  };
}

async function request<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; auth?: string },
): Promise<T> {
  const { url } = settings();
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        ...(init.auth ? { Authorization: init.auth } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // Mounting a share asks PikPak for a captcha token first; give it time.
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new RouteError(502, "无法连接网盘服务（openlist），请稍后重试。", "OPENLIST_UNREACHABLE");
  }
  const data = (await response.json().catch(() => null)) as OpenListResponse<T> | null;
  if (!data) throw new RouteError(502, "网盘服务返回了无法识别的内容。", "OPENLIST_BAD_RESPONSE");
  if (data.code === 401) throw new OpenListError("unauthorized");
  if (data.code !== 200) throw new OpenListError(data.message || `code ${data.code}`);
  return data.data;
}

async function login(): Promise<string> {
  const { username, password } = settings();
  try {
    const data = await request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    return data.token;
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(502, "网盘服务登录失败：请检查 OPENLIST_PASSWORD。", "OPENLIST_LOGIN_FAILED");
  }
}

/** Calls OpenList as admin, logging in again once if the token expired. */
async function call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    token ??= await login();
    try {
      return await request<T>(path, { method, body, auth: token });
    } catch (error) {
      if (error instanceof OpenListError && error.message === "unauthorized" && attempt === 0) {
        token = null;
        continue;
      }
      throw error;
    }
  }
  throw new RouteError(502, "网盘服务登录失败。", "OPENLIST_LOGIN_FAILED");
}

// ── shares ─────────────────────────────────────────────────────────────────

async function findStorage(mountPath: string): Promise<OpenListStorage | undefined> {
  const list = await call<{ content: OpenListStorage[] | null }>(
    "/api/admin/storage/list?page=1&per_page=1000",
    "GET",
  );
  return (list.content || []).find((storage) => storage.mount_path === mountPath);
}

async function mountShare(share: PikPakShare): Promise<string> {
  const mountPath = `${SHARE_ROOT}/${share.shareId}`;
  const existing = await findStorage(mountPath);
  if (existing) {
    let samePassword = false;
    try {
      samePassword = JSON.parse(existing.addition).share_pwd === share.password;
    } catch {
      // Unreadable settings: remount below.
    }
    if (existing.status === "work" && samePassword) return mountPath;
    await call(`/api/admin/storage/delete?id=${existing.id}`, "POST");
  }
  try {
    await call("/api/admin/storage/create", "POST", {
      mount_path: mountPath,
      order: 0,
      driver: "PikPakShare",
      cache_expiration: 30,
      remark: "流光自动添加的 PikPak 分享",
      disabled: false,
      web_proxy: false,
      webdav_policy: "302_redirect",
      down_proxy_url: "",
      addition: JSON.stringify({
        root_folder_id: "",
        share_id: share.shareId,
        share_pwd: share.password,
        platform: "web",
        device_id: "",
        use_transcoding_address: false,
      }),
    });
  } catch (error) {
    // OpenList keeps a storage whose driver failed to start; drop it so the
    // next attempt (e.g. with the right password) starts clean.
    const broken = await findStorage(mountPath).catch(() => undefined);
    if (broken) await call(`/api/admin/storage/delete?id=${broken.id}`, "POST").catch(() => undefined);
    if (error instanceof RouteError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new RouteError(
      400,
      `PikPak 分享打不开（${reason.slice(0, 120)}）。请检查链接是否失效；有提取码的请在链接后加上 ?pwd=提取码。`,
      "PIKPAK_SHARE_FAILED",
    );
  }
  return mountPath;
}

type ShareFile = { path: string; name: string; size: number };

/** Every video in the share, breadth-first, in a stable order. */
async function listVideos(mountPath: string): Promise<ShareFile[]> {
  const files: ShareFile[] = [];
  const queue = [{ path: mountPath, depth: 0 }];
  let calls = 0;
  while (queue.length && calls < MAX_LIST_CALLS && files.length < MAX_FILES) {
    const { path, depth } = queue.shift()!;
    calls += 1;
    const data = await call<{ content: OpenListObject[] | null }>("/api/fs/list", "POST", {
      path,
      password: "",
      page: 1,
      per_page: 0,
      refresh: false,
    });
    for (const item of data.content || []) {
      const itemPath = `${path}/${item.name}`;
      if (item.is_dir) {
        if (depth < 4) queue.push({ path: itemPath, depth: depth + 1 });
      } else if (VIDEO_NAME.test(item.name)) {
        files.push({ path: itemPath, name: itemPath.slice(mountPath.length + 1), size: item.size });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function resolvePikPakShare(
  share: PikPakShare,
  sourceUrl: string,
  fileIndex: number | undefined,
): Promise<ResolvedStream | TorrentChoice> {
  let mountPath: string;
  let files: ShareFile[];
  try {
    mountPath = await mountShare(share);
    files = await listVideos(mountPath);
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(502, `读取 PikPak 分享失败：${(error as Error).message.slice(0, 120)}`, "PIKPAK_LIST_FAILED");
  }
  if (!files.length) {
    throw new RouteError(400, "这个 PikPak 分享里没有可播放的视频文件。", "NO_VIDEO_IN_SHARE");
  }
  const chosenIndex = fileIndex ?? (files.length === 1 ? 0 : undefined);
  if (chosenIndex === undefined) {
    return {
      needsFileChoice: true,
      source: "pikpak",
      title: "PikPak 分享",
      sourceUrl,
      files: files
        .map((file, index) => ({ index, name: file.name, length: file.size }))
        .sort((a, b) => b.length - a.length),
    };
  }
  const file = files[chosenIndex];
  if (!file) throw new RouteError(400, "分享里没有这个文件，可能已被修改。", "BAD_FILE_INDEX");

  let rawUrl: string;
  try {
    const info = await call<{ raw_url: string }>("/api/fs/get", "POST", { path: file.path, password: "" });
    rawUrl = info.raw_url;
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(502, `获取播放地址失败：${(error as Error).message.slice(0, 120)}`, "PIKPAK_LINK_FAILED");
  }
  if (!rawUrl) throw new RouteError(502, "PikPak 没有返回播放地址。", "PIKPAK_NO_LINK");

  return streamFromUrl(new URL(rawUrl), {
    title: baseName(file.name),
    sourceUrl,
    site: "pikpak",
    fileIndex: chosenIndex,
    fileName: file.name,
    // Download links expire and change; the file itself does not.
    key: `pikpak:${share.shareId}:${file.path}`,
  });
}
