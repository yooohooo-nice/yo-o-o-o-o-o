import type { PikPakEntry, PikPakStatus, PikPakTask } from "@contracts/types";
import { baseName, streamFromUrl, type ResolvedStream } from "./media";
import {
  call,
  createStorage,
  deleteStorage,
  errorMessage,
  findStorage,
  listDir,
  rawUrl,
} from "./openlist";
import { RouteError } from "./routeUtils";

// The user's own PikPak drive, mounted in OpenList with the account from
// PIKPAK_USERNAME / PIKPAK_PASSWORD. Files here play in full (unlike share
// links, which may only give a preview), and magnet links can be handed to
// PikPak's offline download so this server never runs BitTorrent itself.

const DRIVE_MOUNT = "/pikpak";
export const OFFLINE_FOLDER = "流光离线下载";
const CHECK_INTERVAL_MS = 5 * 60_000;
// After a failed login, wait before trying again: repeated logins can make
// PikPak demand a verification or lock the account.
const RETRY_AFTER_FAILURE_MS = 2 * 60_000;
export const DRIVE_PREFIX = "pikpak:";

let checkedAt = 0;
let lastFailure: { at: number; message: string } | null = null;

function credentials(): { username: string; password: string } | null {
  const username = process.env.PIKPAK_USERNAME?.trim();
  const password = process.env.PIKPAK_PASSWORD ?? "";
  return username && password ? { username, password } : null;
}

function notConfigured(): RouteError {
  return new RouteError(
    503,
    "还没有设置 PikPak 账号：在服务器的 .env 里填写 PIKPAK_USERNAME 和 PIKPAK_PASSWORD，然后运行 docker compose up -d。",
    "PIKPAK_NOT_CONFIGURED",
  );
}

function loginFailed(message: string): RouteError {
  return new RouteError(
    502,
    `PikPak 登录失败：${message}。请检查 .env 里的账号密码；如果提示需要验证，请先在浏览器打开验证链接完成验证，两分钟后再试。`,
    "PIKPAK_LOGIN_FAILED",
  );
}

/** Makes sure the account is mounted in OpenList with the current credentials. */
export async function ensureDrive(): Promise<void> {
  const account = credentials();
  if (!account) throw notConfigured();
  if (Date.now() - checkedAt < CHECK_INTERVAL_MS) return;
  if (lastFailure && Date.now() - lastFailure.at < RETRY_AFTER_FAILURE_MS) {
    throw loginFailed(lastFailure.message);
  }

  const existing = await findStorage(DRIVE_MOUNT);
  if (existing) {
    let sameAccount = false;
    try {
      const addition = JSON.parse(existing.addition);
      sameAccount = addition.username === account.username && addition.password === account.password;
    } catch {
      // Unreadable settings: remount below.
    }
    if (sameAccount && existing.status === "work") {
      checkedAt = Date.now();
      lastFailure = null;
      return;
    }
    await deleteStorage(existing.id);
  }

  try {
    await createStorage({
      mountPath: DRIVE_MOUNT,
      driver: "PikPak",
      remark: "流光：我的 PikPak",
      addition: {
        root_folder_id: "",
        username: account.username,
        password: account.password,
        platform: process.env.PIKPAK_PLATFORM || "web",
        refresh_token: "",
        captcha_token: "",
        device_id: "",
        disable_media_link: true,
        skip_verification: false,
      },
    });
  } catch (error) {
    if (error instanceof RouteError) throw error;
    // OpenList prefixes driver errors with its own wording; keep PikPak's part.
    const message = errorMessage(error).replace(
      /^(failed init storage but storage is already created: )?(failed init storage: )?/,
      "",
    );
    lastFailure = { at: Date.now(), message };
    throw loginFailed(message);
  }
  checkedAt = Date.now();
  lastFailure = null;
}

export async function driveStatus(): Promise<PikPakStatus> {
  if (!credentials()) return { configured: false, ready: false };
  try {
    await ensureDrive();
    return { configured: true, ready: true };
  } catch (error) {
    return {
      configured: true,
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Normalises a path inside the drive ("/", "/a/b"), rejecting tricks. */
export function drivePath(input: string): string {
  const parts = input.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || /[\u0000-\u001f]/.test(part))) {
    throw new RouteError(400, "路径不正确。", "INVALID_PATH");
  }
  return `/${parts.join("/")}`;
}

function fullPath(path: string): string {
  return path === "/" ? DRIVE_MOUNT : `${DRIVE_MOUNT}${path}`;
}

/** Wraps OpenList errors in a readable message; a stale mount is retried once. */
async function withDrive<T>(action: string, run: () => Promise<T>): Promise<T> {
  await ensureDrive();
  try {
    return await run();
  } catch (error) {
    if (error instanceof RouteError) throw error;
    // The mount may have gone bad (e.g. the token was revoked); remount once.
    checkedAt = 0;
    await ensureDrive();
    try {
      return await run();
    } catch (retryError) {
      if (retryError instanceof RouteError) throw retryError;
      throw new RouteError(502, `${action}失败：${errorMessage(retryError)}`, "PIKPAK_FAILED");
    }
  }
}

export async function listDrive(path: string, refresh = false): Promise<PikPakEntry[]> {
  const dir = drivePath(path);
  const items = await withDrive("读取网盘", () => listDir(fullPath(dir), refresh));
  return items
    .map((item) => ({
      name: item.name,
      path: dir === "/" ? `/${item.name}` : `${dir}/${item.name}`,
      size: item.size,
      isDir: item.is_dir,
      modified: item.modified ? Date.parse(item.modified) || null : null,
    }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, "zh-CN"));
}

/** Plays a file from the drive; `source` is the "pikpak:/path" form kept in history. */
export async function resolveDriveFile(source: string): Promise<ResolvedStream> {
  const path = drivePath(source.slice(DRIVE_PREFIX.length));
  if (path === "/") throw new RouteError(400, "请选择一个视频文件。", "INVALID_PATH");
  const { name, rawUrl: link } = await withDrive("获取播放地址", () => rawUrl(fullPath(path)));
  if (!link) throw new RouteError(502, "PikPak 没有返回播放地址。", "PIKPAK_NO_LINK");
  return streamFromUrl(new URL(link), {
    title: baseName(name),
    sourceUrl: `${DRIVE_PREFIX}${path}`,
    site: "pikpak",
    fileName: name,
    // Download links expire and change; the file itself does not.
    key: `pikpak-drive:${path}`,
  });
}

const OFFLINE_URL = /^(magnet:\?|https?:\/\/|ed2k:\/\/)/i;

/** Hands a magnet (or http/ed2k) link to PikPak's cloud download. */
export async function addOfflineDownload(url: string): Promise<void> {
  const link = url.trim();
  if (!OFFLINE_URL.test(link) || link.length > 8192) {
    throw new RouteError(400, "请粘贴磁力链接（magnet:）或下载地址。", "INVALID_OFFLINE_URL");
  }
  await withDrive("添加离线下载", () =>
    call("/api/fs/add_offline_download", "POST", {
      urls: [link],
      path: `${DRIVE_MOUNT}/${OFFLINE_FOLDER}`,
      tool: "PikPak",
      delete_policy: "delete_never",
    }),
  );
}

type OpenListTask = {
  id: string;
  name: string;
  status: string;
  progress: number;
  error: string;
  start_time: string | null;
};

export async function offlineTasks(): Promise<PikPakTask[]> {
  if (!credentials()) return [];
  const [undone, done] = await Promise.all([
    call<OpenListTask[] | null>("/api/task/offline_download/undone", "GET"),
    call<OpenListTask[] | null>("/api/task/offline_download/done", "GET"),
  ]);
  const describe = (task: OpenListTask, finished: boolean): PikPakTask => ({
    id: task.id,
    // OpenList names tasks "download <url> to [<dir>](...)"; keep the link part.
    name: (task.name.match(/download (.+?) to \[/)?.[1] || task.name).slice(0, 300),
    progress: Number.isFinite(task.progress) ? Math.round(task.progress) : 0,
    finished,
    error: task.error || null,
    startedAt: task.start_time ? Date.parse(task.start_time) || null : null,
  });
  return [
    ...(undone || []).map((task) => describe(task, false)),
    ...(done || []).map((task) => describe(task, true)),
  ]
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, 20);
}
