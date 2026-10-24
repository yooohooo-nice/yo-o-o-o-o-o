import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

const FETCHER = "http://fetcher.test:8080/fetch";
const calls: { url: string; body: Record<string, unknown> }[] = [];
let media: typeof import("./media");

beforeAll(async () => {
  vi.stubEnv("FETCHER_URL", FETCHER);
  vi.resetModules();
  media = await import("./media");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    const target = String(body.url);
    if (target.endsWith("/blocked.m3u8")) {
      return new Response(null, {
        status: 403,
        headers: { "X-Fetcher-Error": "PRIVATE_URL" },
      });
    }
    if (body.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "0",
          "X-Upstream-Content-Length": "123456",
        },
      });
    }
    return new Response("#EXTM3U\n#EXTINF:4,\nseg.ts\n", {
      headers: { "Content-Type": "application/vnd.apple.mpegurl" },
    });
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function tokenOf(streamUrl: string): string {
  return new URL(streamUrl, "http://localhost").searchParams.get("token")!;
}

describe("fetch through the browser-impersonating fetcher", () => {
  it("sends upstream requests to the fetcher and rewrites the playlist", async () => {
    const resolved = await media.resolveMedia("https://cdn.example.com/v/index.m3u8");
    const response = await media.proxyMedia(tokenOf(resolved.streamUrl), undefined, "GET");
    expect(calls.at(-1)).toMatchObject({
      url: FETCHER,
      body: { url: "https://cdn.example.com/v/index.m3u8", method: "GET" },
    });
    expect(await response.text()).toContain("/api/media/stream?token=");
  });

  it("restores the upstream length for HEAD", async () => {
    const resolved = await media.resolveMedia("https://cdn.example.com/v/movie.mp4");
    const response = await media.proxyMedia(tokenOf(resolved.streamUrl), undefined, "HEAD");
    expect(response.headers.get("content-length")).toBe("123456");
  });

  it("maps fetcher errors to route errors", async () => {
    const resolved = await media.resolveMedia("https://cdn.example.com/v/blocked.m3u8");
    await expect(
      media.proxyMedia(tokenOf(resolved.streamUrl), undefined, "GET"),
    ).rejects.toMatchObject({ code: "PRIVATE_MEDIA_URL", status: 403 });
  });
});
