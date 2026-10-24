import { Hono } from "hono";
import type { Handler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { proxyMedia, resolveMedia } from "../media";
import { requireAccess } from "../requireAccess";
import {
  RouteError,
  checkRateLimit,
  clientIp,
  routeErrorResponse,
} from "../routeUtils";

const resolveSchema = z.object({
  url: z.string().min(8).max(4096),
});

export const mediaRoutes = new Hono();

mediaRoutes.post(
  "/resolve",
  bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.body(null, 413) }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      await requireAccess(c);
      checkRateLimit(`resolve:${clientIp(c)}`, 20, 10 * 60 * 1000);
      const { url } = resolveSchema.parse(await c.req.json());
      const result = await resolveMedia(url);
      return c.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return routeErrorResponse(
          c,
          new RouteError(400, "请输入完整的视频地址。", "INVALID_URL"),
        );
      }
      return routeErrorResponse(c, error);
    }
  },
);

const streamHandler: Handler = async (c) => {
  try {
    await requireAccess(c);
    checkRateLimit(`stream:${clientIp(c)}`, 1200, 10 * 60 * 1000);
    const token = c.req.query("token");
    if (!token) {
      throw new RouteError(400, "缺少播放地址。", "MISSING_MEDIA_TOKEN");
    }
    return await proxyMedia(
      token,
      c.req.header("range"),
      c.req.method === "HEAD" ? "HEAD" : "GET",
    );
  } catch (error) {
    return routeErrorResponse(c, error);
  }
};

mediaRoutes.get("/stream", streamHandler);
mediaRoutes.on("HEAD", "/stream", streamHandler);

mediaRoutes.get("/poster", async (c) => {
  try {
    await requireAccess(c);
    checkRateLimit(`poster:${clientIp(c)}`, 120, 10 * 60 * 1000);
    const token = c.req.query("token");
    if (!token) {
      throw new RouteError(400, "缺少封面地址。", "MISSING_MEDIA_TOKEN");
    }
    return await proxyMedia(token, undefined, "GET");
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});
