import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, resolveMedia } from "./media";
import { checkRateLimit } from "./routeUtils";

describe("media URL safety", () => {
  it.each([
    "http://127.0.0.1/video.m3u8",
    "http://10.0.0.8/video.m3u8",
    "http://172.16.0.8/video.m3u8",
    "http://192.168.1.8/video.m3u8",
    "http://localhost/video.m3u8",
    "http://[::1]/video.m3u8",
  ])("rejects private or local media URL %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toMatchObject({
      code: "PRIVATE_MEDIA_URL",
    });
  });

  it("rejects unsupported protocols and ports", async () => {
    await expect(assertPublicUrl("file:///tmp/video.mp4")).rejects.toMatchObject({
      code: "INVALID_MEDIA_URL",
    });
    await expect(
      assertPublicUrl("https://example.com:8443/video.mp4"),
    ).rejects.toMatchObject({ code: "INVALID_MEDIA_URL" });
  });
});

describe("request rate limiting", () => {
  it("rejects requests above the configured window limit", () => {
    const key = `test-rate-limit:${Date.now()}`;
    checkRateLimit(key, 2, 60_000);
    checkRateLimit(key, 2, 60_000);
    expect(() => checkRateLimit(key, 2, 60_000)).toThrowError(
      expect.objectContaining({ code: "RATE_LIMITED", status: 429 }),
    );
  });
});

describe("source failure behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an explicit source error instead of a false success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream unavailable", { status: 503 }),
    );
    await expect(
      resolveMedia("https://jable.tv/videos/ipzz-905/"),
    ).rejects.toMatchObject({
      status: 502,
      code: "SITE_RESOLVE_FAILED",
    });
  }, 30_000);
});
