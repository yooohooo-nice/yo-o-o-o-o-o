import { RouteError } from "./routeUtils";

// Minimal admin client for the OpenList service, which this app uses to talk
// to PikPak: OpenList keeps up with PikPak's unofficial API (captcha tokens,
// client versions, token refresh).

type OpenListResponse<T> = { code: number; message: string; data: T };
export type OpenListStorage = { id: number; mount_path: string; status: string; addition: string };
export type OpenListObject = { name: string; size: number; is_dir: boolean; modified?: string };

export class OpenListError extends Error {}

let token: string | null = null;

function settings() {
  const url = process.env.OPENLIST_URL?.trim();
  if (!url) {
    throw new RouteError(503, "网盘服务未启用：PikPak 功能需要 openlist 服务。", "OPENLIST_DISABLED");
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
      // Mounting PikPak asks it for a captcha token and may log in; give it time.
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
export async function call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
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

export async function findStorage(mountPath: string): Promise<OpenListStorage | undefined> {
  const list = await call<{ content: OpenListStorage[] | null }>(
    "/api/admin/storage/list?page=1&per_page=1000",
    "GET",
  );
  return (list.content || []).find((storage) => storage.mount_path === mountPath);
}

export async function deleteStorage(id: number): Promise<void> {
  await call(`/api/admin/storage/delete?id=${id}`, "POST");
}

/**
 * Creates a storage. When the driver fails to start, OpenList keeps a broken
 * storage behind; it is removed so the next attempt starts clean.
 */
export async function createStorage(storage: {
  mountPath: string;
  driver: string;
  remark: string;
  addition: Record<string, unknown>;
}): Promise<void> {
  try {
    await call("/api/admin/storage/create", "POST", {
      mount_path: storage.mountPath,
      order: 0,
      driver: storage.driver,
      cache_expiration: 30,
      remark: storage.remark,
      disabled: false,
      web_proxy: false,
      webdav_policy: "302_redirect",
      down_proxy_url: "",
      addition: JSON.stringify(storage.addition),
    });
  } catch (error) {
    const broken = await findStorage(storage.mountPath).catch(() => undefined);
    if (broken) await deleteStorage(broken.id).catch(() => undefined);
    throw error;
  }
}

export async function listDir(path: string, refresh = false): Promise<OpenListObject[]> {
  const data = await call<{ content: OpenListObject[] | null }>("/api/fs/list", "POST", {
    path,
    password: "",
    page: 1,
    per_page: 0,
    refresh,
  });
  return data.content || [];
}

export async function rawUrl(path: string): Promise<{ name: string; rawUrl: string }> {
  const info = await call<{ name: string; raw_url: string }>("/api/fs/get", "POST", {
    path,
    password: "",
  });
  return { name: info.name, rawUrl: info.raw_url };
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
