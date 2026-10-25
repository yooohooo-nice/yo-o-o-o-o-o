import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

import type { ResolvedStream } from "./media";
import { parsePikPakShare, resolvePikPakShare } from "./pikpak";

const OPENLIST = "http://openlist.test:5244";
const SHARE_URL = "https://mypikpak.com/s/VOCrj5SaXYDUwUGHheY7tHSXo1";
const MOUNT = "/pikpak-share/VOCrj5SaXYDUwUGHheY7tHSXo1";

type Call = { path: string; body: Record<string, unknown> | null; auth: string | null };

function fakeOpenList(options: { failCreate?: string; expireTokenOnce?: boolean } = {}) {
  const calls: Call[] = [];
  const storages: { id: number; mount_path: string; status: string; addition: string }[] = [];
  let logins = 0;
  let expired = !options.expireTokenOnce;
  const ok = (data: unknown) => Response.json({ code: 200, message: "success", data });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ path: url.pathname + url.search, body, auth });
    if (url.pathname === "/api/auth/login") {
      logins += 1;
      return body?.password === "admin-secret"
        ? ok({ token: `token-${logins}` })
        : Response.json({ code: 400, message: "password is incorrect", data: null });
    }
    if (auth !== `token-${logins}`) return Response.json({ code: 401, message: "token is invalidated", data: null });
    if (url.pathname === "/api/fs/list" && !expired) {
      expired = true;
      return Response.json({ code: 401, message: "token is expired", data: null });
    }
    switch (url.pathname) {
      case "/api/admin/storage/list":
        return ok({ content: storages, total: storages.length });
      case "/api/admin/storage/create":
        storages.push({
          id: storages.length + 1,
          mount_path: String(body?.mount_path),
          status: options.failCreate ? options.failCreate : "work",
          addition: String(body?.addition),
        });
        return options.failCreate
          ? Response.json({ code: 500, message: options.failCreate, data: null })
          : ok({ id: storages.length });
      case "/api/admin/storage/delete": {
        const id = Number(url.searchParams.get("id"));
        storages.splice(storages.findIndex((s) => s.id === id), 1);
        return ok(null);
      }
      case "/api/fs/list": {
        const path = body?.path;
        if (path === MOUNT) {
          return ok({ content: [
            { name: "a.mp4", size: 100, is_dir: false },
            { name: "合集", size: 0, is_dir: true },
            { name: "封面.jpg", size: 5, is_dir: false },
          ] });
        }
        if (path === `${MOUNT}/合集`) {
          return ok({ content: [{ name: "b.mkv", size: 900, is_dir: false }] });
        }
        return ok({ content: [] });
      }
      case "/api/fs/get":
        return ok({ name: "a.mp4", raw_url: "https://dl.example-cdn.com/a?sig=abc" });
    }
    return new Response("not found", { status: 404 });
  });
  return { calls, storages };
}

beforeEach(() => {
  vi.stubEnv("OPENLIST_URL", OPENLIST);
  vi.stubEnv("OPENLIST_PASSWORD", "admin-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("PikPak share links", () => {
  it.each([
    [SHARE_URL, { shareId: "VOCrj5SaXYDUwUGHheY7tHSXo1", password: "" }],
    [`${SHARE_URL}?pwd=ab12`, { shareId: "VOCrj5SaXYDUwUGHheY7tHSXo1", password: "ab12" }],
    ["https://mypikpak.net/s/VOCrj5SaXYDUwUGHheY7tHSXo1/", { shareId: "VOCrj5SaXYDUwUGHheY7tHSXo1", password: "" }],
    ["https://mypikpak.com/drive/all", null],
    ["https://example.com/s/VOCrj5SaXYDUwUGHheY7tHSXo1", null],
  ])("parses %s", (url, expected) => {
    expect(parsePikPakShare(new URL(url))).toEqual(expected);
  });

  it("mounts the share and lists its videos for the user to pick", async () => {
    const { calls, storages } = fakeOpenList();
    const share = parsePikPakShare(new URL(SHARE_URL))!;
    const choice = await resolvePikPakShare(share, SHARE_URL, undefined);
    expect(choice).toMatchObject({ needsFileChoice: true, source: "pikpak" });
    // Videos only, biggest first; indexes stay those of the stable path order.
    expect("files" in choice && choice.files).toEqual([
      { index: 1, name: "合集/b.mkv", length: 900 },
      { index: 0, name: "a.mp4", length: 100 },
    ]);
    expect(storages).toHaveLength(1);
    expect(JSON.parse(storages[0].addition)).toMatchObject({
      share_id: "VOCrj5SaXYDUwUGHheY7tHSXo1",
      share_pwd: "",
    });
    expect(calls.find((c) => c.path === "/api/admin/storage/create")?.body).toMatchObject({
      mount_path: MOUNT,
      driver: "PikPakShare",
    });
  });

  it("plays the chosen file from its download link and reuses the mount", async () => {
    const { calls } = fakeOpenList();
    const share = parsePikPakShare(new URL(SHARE_URL))!;
    await resolvePikPakShare(share, SHARE_URL, undefined);
    const played = (await resolvePikPakShare(share, SHARE_URL, 0)) as ResolvedStream;
    expect(played).toMatchObject({ site: "pikpak", kind: "file", title: "a", fileIndex: 0 });
    expect(played.streamUrl).toMatch(/^\/api\/media\/stream\?token=/);
    expect(calls.filter((c) => c.path === "/api/admin/storage/create")).toHaveLength(1);
    expect(calls.find((c) => c.path === "/api/fs/get")?.body).toMatchObject({ path: `${MOUNT}/a.mp4` });
  });

  it("logs in again when the OpenList token has expired", async () => {
    const { calls } = fakeOpenList({ expireTokenOnce: true });
    const share = parsePikPakShare(new URL(SHARE_URL))!;
    await resolvePikPakShare(share, SHARE_URL, undefined);
    expect(calls.filter((c) => c.path === "/api/auth/login").length).toBeGreaterThanOrEqual(2);
  });

  it("explains a broken share and removes the failed mount", async () => {
    const { storages } = fakeOpenList({ failCreate: "share not found" });
    const share = parsePikPakShare(new URL(`${SHARE_URL}?pwd=wrong`))!;
    await expect(resolvePikPakShare(share, SHARE_URL, undefined)).rejects.toMatchObject({
      code: "PIKPAK_SHARE_FAILED",
    });
    expect(storages).toHaveLength(0);
  });

  it("asks for the openlist service when it is not configured", async () => {
    vi.stubEnv("OPENLIST_URL", "");
    const share = parsePikPakShare(new URL(SHARE_URL))!;
    await expect(resolvePikPakShare(share, SHARE_URL, undefined)).rejects.toMatchObject({
      code: "OPENLIST_DISABLED",
    });
  });
});
