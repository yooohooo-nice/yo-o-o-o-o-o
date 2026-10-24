import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolveMediaResult } from "@contracts/types";
import app from "./boot";

const DEMO_STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const TEST_IP = "198.51.100.24";
let cookie = "";

function localPath(value: string): string {
  const url = new URL(value, "http://localhost");
  return `${url.pathname}${url.search}`;
}

async function resolveWithSession(url: string) {
  return app.request("/api/media/resolve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Forwarded-For": TEST_IP,
    },
    body: JSON.stringify({ url }),
  });
}

describe("password access and media route integration", () => {
  beforeAll(async () => {
    const response = await app.request("/api/access/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": TEST_IP,
      },
      body: JSON.stringify({
        password: process.env.ACCESS_PASSWORD || "LG-26-10-24",
        adultConfirmed: true,
      }),
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") || "";
    cookie = setCookie.split(";")[0];
    expect(cookie).toMatch(/^lg_access=.+/);
  }, 30_000);

  afterAll(async () => {
    if (!cookie) return;
    await app.request("/api/access/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
  });

  it("rejects media resolution without a session", async () => {
    const response = await app.request("/api/media/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: DEMO_STREAM }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "ACCESS_REQUIRED" });
  });

  it("locks repeated password failures without affecting the correct-session IP", async () => {
    // Random per run: a lock left in the database by an earlier run would
    // otherwise fail this test for the next 15 minutes.
    const lockIp = `198.51.100.${Math.floor(Math.random() * 200) + 30}`;
    const attempt = (password: string) => app.request("/api/access/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": lockIp,
      },
      body: JSON.stringify({ password, adultConfirmed: true }),
    });

    for (let count = 1; count <= 4; count += 1) {
      const response = await attempt("definitely-wrong");
      expect(response.status).toBe(401);
    }
    const fifth = await attempt("definitely-wrong");
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toMatchObject({ code: "LOGIN_LOCKED" });
    expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(0);

    const correctWhileLocked = await attempt(
      process.env.ACCESS_PASSWORD || "LG-26-10-24",
    );
    expect(correctWhileLocked.status).toBe(429);
  }, 30_000);

  it("accepts the correct password and reports a valid session", async () => {
    const response = await app.request("/api/access/status", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
  });

  it("resolves the public test stream, rewrites playlists and proxies a segment", async () => {
    const resolvedResponse = await resolveWithSession(DEMO_STREAM);
    expect(resolvedResponse.status).toBe(200);
    const resolved = (await resolvedResponse.json()) as ResolveMediaResult;
    expect(resolved).toMatchObject({ site: "direct", kind: "hls" });

    const masterResponse = await app.request(localPath(resolved.streamUrl), {
      headers: {
        Cookie: cookie,
        "X-Forwarded-For": TEST_IP,
        // Some native HLS clients request playlists with Range. The proxy must
        // still return a complete, rewritten playlist rather than raw partial M3U8.
        Range: "bytes=0-100",
      },
    });
    expect(masterResponse.status).toBe(200);
    const master = await masterResponse.text();
    expect(master).toContain("#EXTM3U");
    expect(master).not.toContain("https://test-streams.mux.dev");

    const variantPath = master
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("/api/media/stream?token="));
    expect(variantPath).toBeTruthy();

    const variantResponse = await app.request(variantPath!, {
      headers: { Cookie: cookie, "X-Forwarded-For": TEST_IP },
    });
    expect(variantResponse.status).toBe(200);
    const variant = await variantResponse.text();
    expect(variant).toContain("#EXTM3U");

    const segmentPath = variant
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("/api/media/stream?token="));
    expect(segmentPath).toBeTruthy();

    const segmentResponse = await app.request(segmentPath!, {
      headers: { Cookie: cookie, "X-Forwarded-For": TEST_IP },
    });
    expect(segmentResponse.status).toBe(200);
    expect(Number(segmentResponse.headers.get("content-length") || 1)).toBeGreaterThan(0);
    await segmentResponse.body?.cancel();
  }, 90_000);

  it("logs out and invalidates the server-side session", async () => {
    const logoutResponse = await app.request("/api/access/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(logoutResponse.status).toBe(200);
    const statusResponse = await app.request("/api/access/status", {
      headers: { Cookie: cookie },
    });
    expect(await statusResponse.json()).toEqual({ authenticated: false });
    const protectedResponse = await resolveWithSession(DEMO_STREAM);
    expect(protectedResponse.status).toBe(401);
    cookie = "";
  });
});
