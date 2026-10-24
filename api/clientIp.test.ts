import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "./routeUtils";

const app = new Hono();
app.get("/ip", (c) => c.text(clientIp(c)));

function ipFor(headers: Record<string, string>) {
  return Promise.resolve(app.request("/ip", { headers })).then((res) =>
    res.text(),
  );
}

describe("clientIp", () => {
  const original = process.env.TRUST_PROXY;
  afterEach(() => {
    process.env.TRUST_PROXY = original;
  });

  it("ignores X-Forwarded-For unless a trusted proxy is configured", async () => {
    delete process.env.TRUST_PROXY;
    expect(await ipFor({ "X-Forwarded-For": "1.2.3.4" })).toBe("local");
    expect(await ipFor({ "X-Real-IP": "1.2.3.4" })).toBe("local");
  });

  it("uses the hop appended by the trusted proxy, not a spoofed one", async () => {
    process.env.TRUST_PROXY = "1";
    expect(await ipFor({ "X-Forwarded-For": "6.6.6.6, 1.2.3.4" })).toBe("1.2.3.4");
    expect(await ipFor({ "X-Forwarded-For": "1.2.3.4" })).toBe("1.2.3.4");
  });
});
