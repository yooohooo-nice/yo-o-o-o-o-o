import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

type Storage = { id: number; mount_path: string; status: string; addition: string };
type Call = { path: string; body: Record<string, unknown> | null };

function fakeOpenList(options: { loginError?: string } = {}) {
  const calls: Call[] = [];
  const storages: Storage[] = [];
  const ok = (data: unknown) => Response.json({ code: 200, message: "success", data });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ path: url.pathname + url.search, body });
    switch (url.pathname) {
      case "/api/auth/login":
        return ok({ token: "t" });
      case "/api/admin/storage/list":
        return ok({ content: storages, total: storages.length });
      case "/api/admin/storage/create":
        storages.push({
          id: storages.length + 1,
          mount_path: String(body?.mount_path),
          status: options.loginError || "work",
          addition: String(body?.addition),
        });
        return options.loginError
          ? Response.json({ code: 500, message: options.loginError, data: { id: storages.length } })
          : ok({ id: storages.length });
      case "/api/admin/storage/delete":
        storages.splice(storages.findIndex((s) => s.id === Number(url.searchParams.get("id"))), 1);
        return ok(null);
      case "/api/fs/list":
        return ok({ content: [
          { name: "电影.mkv", size: 2_000_000_000, is_dir: false, modified: "2026-10-25T10:00:00Z" },
          { name: "流光转存", size: 0, is_dir: true, modified: "2026-10-25T09:00:00Z" },
        ] });
      case "/api/fs/get":
        return ok({ name: "a.mp4", raw_url: "https://dl.pikpak-cdn.example/a?sig=1" });
    }
    return new Response("not found", { status: 404 });
  });
  return { calls, storages };
}

async function load() {
  vi.resetModules();
  return import("./pikpakDrive");
}

beforeEach(() => {
  vi.stubEnv("OPENLIST_URL", "http://openlist.test:5244");
  vi.stubEnv("OPENLIST_PASSWORD", "admin-secret");
  vi.stubEnv("PIKPAK_USERNAME", "me@example.com");
  vi.stubEnv("PIKPAK_PASSWORD", "pw1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("My PikPak drive", () => {
  it("reports when no account is configured", async () => {
    vi.stubEnv("PIKPAK_USERNAME", "");
    fakeOpenList();
    const drive = await load();
    expect(await drive.driveStatus()).toEqual({ configured: false, ready: false });
    await expect(drive.listDrive("/")).rejects.toMatchObject({ code: "PIKPAK_NOT_CONFIGURED" });
  });

  it("mounts the account once and lists folders first", async () => {
    const { calls, storages } = fakeOpenList();
    const drive = await load();
    const items = await drive.listDrive("/");
    expect(items.map((item) => [item.name, item.isDir, item.path])).toEqual([
      ["流光转存", true, "/流光转存"],
      ["电影.mkv", false, "/电影.mkv"],
    ]);
    expect(JSON.parse(storages[0].addition)).toMatchObject({ username: "me@example.com", password: "pw1" });
    expect(calls.find((c) => c.path === "/api/admin/storage/create")?.body).toMatchObject({
      mount_path: "/pikpak",
      driver: "PikPak",
    });
    await drive.listDrive("/流光转存");
    expect(calls.filter((c) => c.path === "/api/admin/storage/create")).toHaveLength(1);
    expect(calls.at(-1)?.body).toMatchObject({ path: "/pikpak/流光转存" });
  });

  it("remounts when the password in .env changes", async () => {
    const { storages } = fakeOpenList();
    storages.push({
      id: 7,
      mount_path: "/pikpak",
      status: "work",
      addition: JSON.stringify({ username: "me@example.com", password: "old" }),
    });
    const drive = await load();
    await drive.listDrive("/");
    expect(storages).toHaveLength(1);
    expect(JSON.parse(storages[0].addition).password).toBe("pw1");
  });

  it("shows the login error and does not hammer PikPak with retries", async () => {
    const { calls, storages } = fakeOpenList({ loginError: "need verify: https://user.mypikpak.com/verify" });
    const drive = await load();
    await expect(drive.listDrive("/")).rejects.toMatchObject({ code: "PIKPAK_LOGIN_FAILED" });
    await expect(drive.listDrive("/")).rejects.toMatchObject({
      message: expect.stringContaining("https://user.mypikpak.com/verify"),
    });
    expect(calls.filter((c) => c.path === "/api/admin/storage/create")).toHaveLength(1);
    expect(storages).toHaveLength(0);
  });

  it("rejects paths that try to leave the drive", async () => {
    fakeOpenList();
    const drive = await load();
    await expect(drive.listDrive("/../pikpak-share")).rejects.toMatchObject({ code: "INVALID_PATH" });
  });

  it("plays a drive file from its download link", async () => {
    const { calls } = fakeOpenList();
    const drive = await load();
    const played = await drive.resolveDriveFile("pikpak:/流光转存/a.mp4");
    expect(played).toMatchObject({ site: "pikpak", kind: "file", title: "a", sourceUrl: "pikpak:/流光转存/a.mp4" });
    expect(calls.find((c) => c.path === "/api/fs/get")?.body).toMatchObject({ path: "/pikpak/流光转存/a.mp4" });
  });
});
