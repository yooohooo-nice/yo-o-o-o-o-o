import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

import type { ResolvedStream } from "./media";

const SHARE_ID = "VOCrj5SaXYDUwUGHheY7tHSXo1";
const SHARE_URL = `https://mypikpak.com/s/${SHARE_ID}`;

type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null; headers: Headers };
type DriveFile = { id: string; name: string; size: string; kind: string; parent: string };

/** A small in-memory stand-in for PikPak's user and drive APIs. */
function fakePikPak(options: {
  verifyUrl?: string;
  expireAccessOnce?: boolean;
  expireCaptchaOnce?: boolean;
  rejectTargetFolder?: boolean;
  passCode?: string;
  drive?: DriveFile[];
} = {}) {
  const calls: Call[] = [];
  const drive: DriveFile[] = options.drive ? [...options.drive] : [];
  let accessExpired = !!options.expireAccessOnce;
  let captchaExpired = !!options.expireCaptchaOnce;
  let tokens = 0;
  let captchas = 0;
  const share = [
    { id: "s-a", name: "a.mp4", size: "100", kind: "drive#file" },
    { id: "s-dir", name: "合集", size: "0", kind: "drive#folder" },
    { id: "s-cover", name: "封面.jpg", size: "5", kind: "drive#file" },
  ];
  const nested = [{ id: "s-b", name: "b.mp4", size: "900", kind: "drive#file" }];
  const fail = (error_code: number, error: string, status = 400) =>
    Response.json({ error_code, error, error_description: error }, { status });

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const headers = new Headers(init?.headers);
    const method = init?.method || "GET";
    calls.push({ method, path: url.pathname, query: url.searchParams, body, headers });
    const authed = headers.get("authorization") === `Bearer access-${tokens}`;

    switch (`${method} ${url.pathname}`) {
      case "POST /v1/shield/captcha/init":
        if (options.verifyUrl) return Response.json({ url: options.verifyUrl });
        captchas += 1;
        return Response.json({ captcha_token: `captcha-${captchas}` });
      case "POST /v1/auth/signin":
        if (body?.password !== "pw") return fail(4002, "invalid_grant");
        tokens += 1;
        return Response.json({ access_token: `access-${tokens}`, refresh_token: "refresh", sub: "user-1" });
      case "POST /v1/auth/token":
        tokens += 1;
        return Response.json({ access_token: `access-${tokens}`, refresh_token: "refresh-2" });
    }
    if (!authed) return fail(16, "unauthenticated", 401);
    if (accessExpired) {
      accessExpired = false;
      return fail(16, "unauthenticated", 401);
    }
    if (captchaExpired) {
      captchaExpired = false;
      return fail(9, "captcha_invalid");
    }
    const q = url.searchParams;
    switch (`${method} ${url.pathname}`) {
      case "GET /drive/v1/share":
        if ((options.passCode || "") !== q.get("pass_code")) {
          return Response.json({ share_status: "PASS_CODE_ERROR", files: [] });
        }
        return Response.json({ share_status: "OK", pass_code_token: "pct", files: share });
      case "GET /drive/v1/share/detail":
        return Response.json({ share_status: "OK", files: q.get("parent_id") === "s-dir" ? nested : [] });
      case "GET /drive/v1/files":
        return Response.json({ files: drive.filter((f) => f.parent === q.get("parent_id")) });
      case "POST /drive/v1/files": {
        const folder = { id: `own-${drive.length + 1}`, name: String(body?.name), size: "0", kind: "drive#folder", parent: "" };
        drive.push(folder);
        return Response.json({ file: folder });
      }
      case "POST /drive/v1/share/restore": {
        if (options.rejectTargetFolder && body?.specify_parent_id) return fail(3, "invalid_argument");
        const parent = body?.specify_parent_id ? String(body.parent_id) : "";
        for (const id of body?.file_ids as string[]) {
          const source = [...share, ...nested].find((f) => f.id === id)!;
          drive.push({ ...source, id: `own-${drive.length + 1}`, parent });
        }
        return Response.json({ restore_status: "RESTORE_COMPLETE" });
      }
    }
    const fileMatch = url.pathname.match(/^\/drive\/v1\/files\/(.+)$/);
    if (method === "GET" && fileMatch) {
      const file = drive.find((f) => f.id === decodeURIComponent(fileMatch[1]));
      if (!file) return fail(404, "file_not_found", 404);
      return Response.json({ id: file.id, name: file.name, web_content_link: `https://vod.example-cdn.com/${file.id}?sig=1` });
    }
    return new Response("not found", { status: 404 });
  });
  return { calls, drive };
}

async function load() {
  vi.resetModules();
  const pikpak = await import("./pikpak");
  const api = await import("./pikpakApi");
  return { ...pikpak, ...api };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  vi.stubEnv("PIKPAK_USERNAME", "someone@example.com");
  vi.stubEnv("PIKPAK_PASSWORD", "pw");
  vi.stubEnv("OPENLIST_URL", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function resolve(m: Awaited<ReturnType<typeof load>>, url: string, fileIndex?: number) {
  const pending = m.resolvePikPakShare(m.parsePikPakShare(new URL(url))!, url, fileIndex);
  pending.catch(() => {}); // rejections are checked by the caller
  // Let the short "wait for the save to appear" pauses pass instantly.
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(2000);
  return pending;
}

describe("PikPak share saving (with an account)", () => {
  it("signs captcha requests the way the web client does", async () => {
    const m = await load();
    const sign = m.captchaSign("device", "1700000000000");
    expect(sign).toMatch(/^1\.[0-9a-f]{32}$/);
    expect(m.captchaSign("device", "1700000000000")).toBe(sign);
    expect(m.captchaSign("other", "1700000000000")).not.toBe(sign);
    expect(m.actionOf("GET", "https://api-drive.mypikpak.net/drive/v1/files?x=1")).toBe("GET:/drive/v1/files");
  });

  it("logs in and lists the share's videos without saving anything yet", async () => {
    const { calls, drive } = fakePikPak();
    const m = await load();
    const choice = await resolve(m, SHARE_URL);
    expect(choice).toMatchObject({ needsFileChoice: true, source: "pikpak" });
    expect("files" in choice && choice.files).toEqual([
      { index: 1, name: "合集/b.mp4", length: 900 },
      { index: 0, name: "a.mp4", length: 100 },
    ]);
    const signin = calls.find((c) => c.path === "/v1/auth/signin")!;
    expect(signin.body).toMatchObject({ username: "someone@example.com", captcha_token: "captcha-1" });
    const init = calls.find((c) => c.path === "/v1/shield/captcha/init")!;
    expect(init.body).toMatchObject({ action: "POST:/v1/auth/signin", meta: { email: "someone@example.com" } });
    expect(calls.some((c) => c.path === "/drive/v1/share/restore")).toBe(false);
    expect(drive).toHaveLength(0);
  });

  it("saves the chosen file into 流光转存 and plays the saved copy", async () => {
    const { calls, drive } = fakePikPak();
    const m = await load();
    const played = (await resolve(m, SHARE_URL, 0)) as ResolvedStream;
    expect(played).toMatchObject({ site: "pikpak", kind: "file", title: "a", fileIndex: 0, sourceUrl: SHARE_URL });
    expect(played.streamUrl).toMatch(/^\/api\/media\/stream\?token=/);
    const folder = drive.find((f) => f.name === m.SAVE_FOLDER)!;
    expect(drive.find((f) => f.name === "a.mp4")).toMatchObject({ parent: folder.id });
    expect(calls.find((c) => c.path === "/drive/v1/share/restore")?.body).toMatchObject({
      share_id: SHARE_ID,
      pass_code_token: "pct",
      file_ids: ["s-a"],
      parent_id: folder.id,
    });
  });

  it("does not save the same file twice", async () => {
    const { calls } = fakePikPak();
    const m = await load();
    await resolve(m, SHARE_URL, 0);
    await resolve(m, SHARE_URL, 0);
    expect(calls.filter((c) => c.path === "/drive/v1/share/restore")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/v1/auth/signin")).toHaveLength(1);
  });

  it("finds a copy saved before, even after a restart", async () => {
    const { calls } = fakePikPak({
      drive: [
        { id: "f1", name: "流光转存", size: "0", kind: "drive#folder", parent: "" },
        { id: "f2", name: "b.mp4", size: "900", kind: "drive#file", parent: "f1" },
      ],
    });
    const m = await load();
    const played = (await resolve(m, SHARE_URL, 1)) as ResolvedStream;
    expect(played).toMatchObject({ title: "b" });
    expect(calls.some((c) => c.path === "/drive/v1/share/restore")).toBe(false);
    expect(calls.some((c) => c.path === "/drive/v1/files/f2")).toBe(true);
  });

  it("falls back to a plain save when the target folder is not accepted", async () => {
    const { drive } = fakePikPak({ rejectTargetFolder: true });
    const m = await load();
    const played = (await resolve(m, SHARE_URL, 0)) as ResolvedStream;
    expect(played).toMatchObject({ title: "a" });
    expect(drive.find((f) => f.name === "a.mp4")).toMatchObject({ parent: "" });
  });

  it("renews an expired access token and an expired captcha", async () => {
    const tokenCase = fakePikPak({ expireAccessOnce: true });
    let m = await load();
    await resolve(m, SHARE_URL);
    expect(tokenCase.calls.some((c) => c.path === "/v1/auth/token")).toBe(true);
    vi.restoreAllMocks();

    const captchaCase = fakePikPak({ expireCaptchaOnce: true });
    m = await load();
    await resolve(m, SHARE_URL);
    const inits = captchaCase.calls.filter((c) => c.path === "/v1/shield/captcha/init");
    expect(inits.at(-1)?.body).toMatchObject({ action: "GET:/drive/v1/share", meta: { user_id: "user-1" } });
  });

  it("explains a missing or wrong share password", async () => {
    fakePikPak({ passCode: "ab12" });
    const m = await load();
    await expect(resolve(m, SHARE_URL)).rejects.toMatchObject({ code: "PIKPAK_SHARE_PASSWORD" });
    const choice = await resolve(m, `${SHARE_URL}?pwd=ab12`);
    expect(choice).toMatchObject({ needsFileChoice: true });
  });

  it("passes on PikPak's device verification link", async () => {
    fakePikPak({ verifyUrl: "https://user.mypikpak.net/verify?x=1" });
    const m = await load();
    const error = await resolve(m, SHARE_URL).catch((e: Error) => e);
    expect(error).toMatchObject({ code: "PIKPAK_LOGIN_FAILED" });
    expect((error as Error).message).toContain("https://user.mypikpak.net/verify?x=1");
  });

  it("reports a wrong password without retrying right away", async () => {
    vi.stubEnv("PIKPAK_PASSWORD", "wrong");
    const { calls } = fakePikPak();
    const m = await load();
    await expect(resolve(m, SHARE_URL)).rejects.toMatchObject({ code: "PIKPAK_LOGIN_FAILED" });
    await expect(resolve(m, SHARE_URL)).rejects.toMatchObject({ code: "PIKPAK_LOGIN_FAILED" });
    expect(calls.filter((c) => c.path === "/v1/auth/signin")).toHaveLength(1);
  });
});
