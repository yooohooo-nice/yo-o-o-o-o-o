import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicUrl,
  formatFromBytes,
  formatFromExtension,
  resolveMedia,
} from "./media";
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

describe("direct link format detection", () => {
  it.each([
    ["/v/index.m3u8", "hls"],
    ["/v/movie.MP4", "file"],
    ["/v/clip.webm", "file"],
    ["/v/movie.mkv", "remux"],
    ["/v/live.flv", "remux"],
    ["/v/old.avi", "remux"],
    ["/d/pack.torrent", "torrent"],
    ["/play", null],
  ])("by extension %s → %s", (path, expected) => {
    expect(formatFromExtension(path)).toBe(expected);
  });

  const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(512)]);
  it.each([
    ["HLS playlist", Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n"), "", "hls"],
    ["MP4", pad(Buffer.from("\0\0\0\x18ftypisom", "latin1")), "", "file"],
    ["WebM", pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, ...Buffer.from("webm")])), "", "file"],
    ["Matroska", pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, ...Buffer.from("matroska")])), "", "remux"],
    ["FLV", pad(Buffer.from("FLV\x01")), "", "remux"],
    ["AVI", pad(Buffer.from("RIFF\0\0\0\0AVI LIST", "latin1")), "", "remux"],
    ["torrent", Buffer.from("d8:announce35:udp://tracker"), "", "torrent"],
    ["web page", Buffer.from("<!DOCTYPE html><html>"), "text/html; charset=utf-8", "html"],
    ["video/* header only", Buffer.alloc(16), "video/x-matroska", "remux"],
    ["unknown bytes", Buffer.alloc(16), "application/octet-stream", null],
  ])("by content: %s", (_name, head, type, expected) => {
    expect(formatFromBytes(head as Buffer, type as string)).toBe(expected);
  });

  it("accepts magnet links and rejects malformed ones", async () => {
    await expect(resolveMedia("magnet:?dn=no-hash")).rejects.toMatchObject({
      code: "INVALID_MAGNET",
    });
  });
});
