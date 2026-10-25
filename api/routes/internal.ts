import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Handler } from "hono";
import { proxyMedia } from "../media";
import { internalSecret } from "../mediaWorker";
import { RouteError, routeErrorResponse } from "../routeUtils";

// Lets the media worker read a remote source through this app, so remuxing
// gets the same public-address checks and Cloudflare-proof fetching as
// playback. Guarded by the internal secret rather than a browser session.
export const internalRoutes = new Hono();

function authorized(header: string | undefined): boolean {
  const received = Buffer.from(header || "");
  const expected = Buffer.from(internalSecret());
  return received.length === expected.length && timingSafeEqual(received, expected);
}

const sourceHandler: Handler = async (c) => {
  try {
    if (!authorized(c.req.header("x-internal-secret"))) {
      throw new RouteError(403, "forbidden", "FORBIDDEN");
    }
    const token = c.req.query("token");
    if (!token) throw new RouteError(400, "缺少地址。", "MISSING_MEDIA_TOKEN");
    return await proxyMedia(token, c.req.header("range"), c.req.method === "HEAD" ? "HEAD" : "GET");
  } catch (error) {
    return routeErrorResponse(c, error);
  }
};

internalRoutes.get("/source", sourceHandler);
internalRoutes.on("HEAD", "/source", sourceHandler);
