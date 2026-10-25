import { createHash } from "node:crypto";
import { RouteError } from "./routeUtils";

// Direct client for PikPak's (unofficial) API, used for what OpenList cannot
// do: saving ("转存") a share into the user's own drive, so it plays in full.
// Client constants, the captcha signature and the login flow follow
// OpenList's PikPak driver (drivers/pikpak, "web" platform); when PikPak
// changes them, compare with the latest OpenList release.

const CLIENT_ID = "YUMx5nI8ZU8Ap8pm";
const CLIENT_SECRET = "dbw2OtmVEeuUvIptb1Coyg";
const CLIENT_VERSION = "2.0.0";
const PACKAGE_NAME = "mypikpak.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";
const ALGORITHMS = [
  "C9qPpZLN8ucRTaTiUMWYS9cQvWOE",
  "+r6CQVxjzJV6LCV",
  "F",
  "pFJRC",
  "9WXYIDGrwTCz2OiVlgZa90qpECPD6olt",
  "/750aCr4lm/Sly/c",
  "RB+DT/gZCrbV",
  "",
  "CyLsf7hdkIRxRm215hl",
  "7xHvLi2tOYP0Y92b",
  "ZGTXXxu8E/MIWaEDB+Sm/",
  "1UI3",
  "E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO",
  "ihtqpG6FMt65+Xk+tWUH2",
  "NhXXU9rg4XXdzo7u5o",
];

const USER_HOST = "https://user.mypikpak.net";
const DRIVE_HOST = "https://api-drive.mypikpak.net";
const LOGIN_RETRY_MS = 2 * 60_000;

const md5 = (value: string) => createHash("md5").update(value).digest("hex");

export function captchaSign(deviceId: string, timestamp: string): string {
  let sign = `${CLIENT_ID}${CLIENT_VERSION}${PACKAGE_NAME}${deviceId}${timestamp}`;
  for (const algorithm of ALGORITHMS) sign = md5(sign + algorithm);
  return `1.${sign}`;
}

/** "GET:/drive/v1/files" — the action a captcha token is issued for. */
export function actionOf(method: string, url: string): string {
  return `${method}:${new URL(url).pathname}`;
}

type PikPakError = { error_code?: number; error?: string; error_description?: string };

export class PikPakApiError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

type Session = {
  username: string;
  password: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  captchaToken: string;
};

let session: Session | null = null;
let lastLoginFailure: { at: number; message: string } | null = null;

export function accountFromEnv(): { username: string; password: string } | null {
  const username = process.env.PIKPAK_USERNAME?.trim();
  const password = process.env.PIKPAK_PASSWORD ?? "";
  return username && password ? { username, password } : null;
}

async function send(
  method: "GET" | "POST",
  url: string,
  options: { query?: Record<string, string>; body?: unknown; withAuth?: boolean } = {},
): Promise<Record<string, unknown>> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.query || {})) target.searchParams.set(key, value);
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
  };
  if (session) {
    headers["X-Device-ID"] = session.deviceId;
    if (session.captchaToken) headers["X-Captcha-Token"] = session.captchaToken;
    if (options.withAuth !== false && session.accessToken) {
      headers.Authorization = `Bearer ${session.accessToken}`;
    }
  }
  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new PikPakApiError(-1, "无法连接 PikPak 服务器");
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown> & PikPakError;
  if (data.error_code || data.error) {
    throw new PikPakApiError(
      Number(data.error_code) || response.status,
      String(data.error_description || data.error || `HTTP ${response.status}`),
    );
  }
  if (!response.ok) throw new PikPakApiError(response.status, `HTTP ${response.status}`);
  return data;
}

async function refreshCaptcha(action: string, meta: Record<string, string>): Promise<void> {
  const current = session!;
  // Like OpenList, the bearer token is sent once logged in (none before).
  const data = await send("POST", `${USER_HOST}/v1/shield/captcha/init`, {
    query: { client_id: CLIENT_ID },
    body: {
      action,
      captcha_token: current.captchaToken,
      client_id: CLIENT_ID,
      device_id: current.deviceId,
      meta,
      redirect_uri: "xlaccsdk01://xbase.cloud/callback?state=harbor",
    },
  });
  if (data.url) {
    throw new PikPakApiError(
      -2,
      `PikPak 要求验证这个新设备，请用浏览器打开 ${String(data.url)} 完成验证，两分钟后再试`,
    );
  }
  current.captchaToken = String(data.captcha_token || "");
}

function signedMeta(extra: Record<string, string>): Record<string, string> {
  const timestamp = String(Date.now());
  return {
    ...extra,
    client_version: CLIENT_VERSION,
    package_name: PACKAGE_NAME,
    timestamp,
    captcha_sign: captchaSign(session!.deviceId, timestamp),
  };
}

async function login(account: { username: string; password: string }): Promise<void> {
  // A device id of our own keeps this session separate from OpenList's.
  session = {
    ...account,
    deviceId: md5(`liuguang:${account.username}`),
    accessToken: "",
    refreshToken: "",
    userId: "",
    captchaToken: "",
  };
  const signin = `${USER_HOST}/v1/auth/signin`;
  const field = /\w+([-+.]\w+)*@\w+([-.]\w+)*\.\w+([-.]\w+)*/.test(account.username)
    ? "email"
    : account.username.length >= 11 && account.username.length <= 18
      ? "phone_number"
      : "username";
  const who: Record<string, string> = { [field]: account.username };
  await refreshCaptcha(actionOf("POST", signin), signedMeta(who));
  const data = await send("POST", signin, {
    query: { client_id: CLIENT_ID },
    withAuth: false,
    body: {
      captcha_token: session.captchaToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      username: account.username,
      password: account.password,
    },
  });
  session.accessToken = String(data.access_token || "");
  session.refreshToken = String(data.refresh_token || "");
  session.userId = String(data.sub || "");
  if (!session.accessToken) throw new PikPakApiError(-3, "登录没有返回 access_token");
  await refreshCaptcha(
    actionOf("GET", `${DRIVE_HOST}/drive/v1/files`),
    signedMeta({ user_id: session.userId }),
  );
}

async function refreshAccess(): Promise<void> {
  const current = session!;
  try {
    const data = await send("POST", `${USER_HOST}/v1/auth/token`, {
      query: { client_id: CLIENT_ID },
      withAuth: false,
      body: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      },
    });
    current.accessToken = String(data.access_token || "");
    current.refreshToken = String(data.refresh_token || current.refreshToken);
  } catch {
    await login({ username: current.username, password: current.password });
  }
}

async function ensureSession(): Promise<void> {
  const account = accountFromEnv();
  if (!account) {
    throw new RouteError(
      503,
      "还没有设置 PikPak 账号：在服务器的 .env 里填写 PIKPAK_USERNAME 和 PIKPAK_PASSWORD，然后运行 docker compose up -d。",
      "PIKPAK_NOT_CONFIGURED",
    );
  }
  if (session && session.username === account.username && session.password === account.password && session.accessToken) {
    return;
  }
  if (lastLoginFailure && Date.now() - lastLoginFailure.at < LOGIN_RETRY_MS) {
    throw new RouteError(502, `PikPak 登录失败：${lastLoginFailure.message}`, "PIKPAK_LOGIN_FAILED");
  }
  try {
    await login(account);
    lastLoginFailure = null;
  } catch (error) {
    session = null;
    const message = error instanceof Error ? error.message : String(error);
    lastLoginFailure = { at: Date.now(), message };
    throw new RouteError(502, `PikPak 登录失败：${message}`, "PIKPAK_LOGIN_FAILED");
  }
}

/** An authenticated drive API call that renews tokens the way OpenList does. */
async function api(
  method: "GET" | "POST",
  url: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  await ensureSession();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send(method, url, options);
    } catch (error) {
      if (!(error instanceof PikPakApiError) || attempt >= 2) throw error;
      if ([16, 4121, 4122].includes(error.code)) {
        await refreshAccess(); // access token expired
      } else if (error.code === 9) {
        await refreshCaptcha(actionOf(method, url), signedMeta({ user_id: session!.userId })); // captcha expired
      } else {
        throw error;
      }
    }
  }
}

// ── shares ────────────────────────────────────────────────────────────────

export type ShareEntry = { id: string; name: string; size: number; isDir: boolean };

const FILE_FILTERS = '{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}';

function toEntry(file: Record<string, unknown>): ShareEntry {
  return {
    id: String(file.id),
    name: String(file.name),
    size: Number(file.size) || 0,
    isDir: file.kind === "drive#folder",
  };
}

function shareProblem(status: string, text: string): RouteError {
  if (status === "PASS_CODE_EMPTY" || status === "PASS_CODE_ERROR") {
    return new RouteError(400, "这个分享需要提取码（或提取码不对）：请在链接后加上 ?pwd=提取码。", "PIKPAK_SHARE_PASSWORD");
  }
  return new RouteError(400, `PikPak 分享不可用：${text || status}`, "PIKPAK_SHARE_UNAVAILABLE");
}

/** Opens a share: its pass-code token and top-level files. */
export async function openShare(
  shareId: string,
  passCode: string,
): Promise<{ passCodeToken: string; files: ShareEntry[] }> {
  const data = await api("GET", `${DRIVE_HOST}/drive/v1/share`, {
    query: { share_id: shareId, pass_code: passCode, thumbnail_size: "SIZE_LARGE", limit: "100" },
  });
  const status = String(data.share_status || "OK");
  if (status !== "OK") throw shareProblem(status, String(data.share_status_text || ""));
  return {
    passCodeToken: String(data.pass_code_token || ""),
    files: ((data.files as Record<string, unknown>[]) || []).map(toEntry),
  };
}

export async function listShareFolder(
  shareId: string,
  passCodeToken: string,
  parentId: string,
): Promise<ShareEntry[]> {
  const files: ShareEntry[] = [];
  let pageToken = "";
  do {
    const data = await api("GET", `${DRIVE_HOST}/drive/v1/share/detail`, {
      query: {
        parent_id: parentId,
        share_id: shareId,
        thumbnail_size: "SIZE_LARGE",
        with_audit: "true",
        limit: "100",
        filters: FILE_FILTERS,
        page_token: pageToken,
        pass_code_token: passCodeToken,
      },
    });
    const status = String(data.share_status || "OK");
    if (status !== "OK") throw shareProblem(status, String(data.share_status_text || ""));
    files.push(...((data.files as Record<string, unknown>[]) || []).map(toEntry));
    pageToken = String(data.next_page_token || "");
  } while (pageToken && files.length < 1000);
  return files;
}

// ── own drive ─────────────────────────────────────────────────────────────

export async function listMyFolder(parentId: string): Promise<ShareEntry[]> {
  const files: ShareEntry[] = [];
  let pageToken = "";
  do {
    const data = await api("GET", `${DRIVE_HOST}/drive/v1/files`, {
      query: {
        parent_id: parentId,
        thumbnail_size: "SIZE_LARGE",
        with_audit: "true",
        limit: "100",
        filters: FILE_FILTERS,
        page_token: pageToken,
      },
    });
    files.push(...((data.files as Record<string, unknown>[]) || []).map(toEntry));
    pageToken = String(data.next_page_token || "");
  } while (pageToken && files.length < 2000);
  return files;
}

/** Finds or creates a top-level folder, returning its id. */
export async function ensureMyFolder(name: string): Promise<string> {
  const existing = (await listMyFolder("")).find((file) => file.isDir && file.name === name);
  if (existing) return existing.id;
  const data = await api("POST", `${DRIVE_HOST}/drive/v1/files`, {
    body: { kind: "drive#folder", parent_id: "", name },
  });
  const file = (data.file as Record<string, unknown>) || {};
  if (!file.id) throw new PikPakApiError(-4, "创建文件夹失败");
  return String(file.id);
}

/** Saves share files into a folder of the user's drive ("转存"). */
export async function restoreShareFiles(
  shareId: string,
  passCodeToken: string,
  fileIds: string[],
  parentId: string,
): Promise<void> {
  const url = `${DRIVE_HOST}/drive/v1/share/restore`;
  const base = { share_id: shareId, pass_code_token: passCodeToken, file_ids: fileIds };
  try {
    await api("POST", url, { body: { ...base, specify_parent_id: true, parent_id: parentId } });
  } catch (error) {
    // Older API variants reject the target-folder fields; fall back to the
    // plain request (files then land in the drive root).
    if (!(error instanceof PikPakApiError) || ![400, 3].includes(error.code)) throw error;
    await api("POST", url, { body: base });
  }
}

/** A direct download link for a file in the user's own drive. */
export async function fileLink(fileId: string): Promise<{ name: string; url: string }> {
  const data = await api("GET", `${DRIVE_HOST}/drive/v1/files/${encodeURIComponent(fileId)}`, {
    query: { _magic: "2021", usage: "FETCH", thumbnail_size: "SIZE_LARGE" },
  });
  const medias = (data.medias as { link?: { url?: string } }[]) || [];
  const url = String(data.web_content_link || medias[0]?.link?.url || "");
  return { name: String(data.name || ""), url };
}

/** For tests: forget the current login. */
export function resetPikPakSession(): void {
  session = null;
  lastLoginFailure = null;
}
