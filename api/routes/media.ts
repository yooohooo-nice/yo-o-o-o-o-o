import { Hono } from "hono";
import type { Handler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ResolveResponse } from "@contracts/types";
import { recordPlay } from "../library";
import { proxyMedia, resolveMedia } from "../media";
import { proxyWorkerStream } from "../mediaWorker";
import { requireAccess } from "../requireAccess";
import {
  RouteError,
  checkRateLimit,
  clientIp,
  routeErrorResponse,
} from "../routeUtils";

const resolveSchema = z.object({
  url: z.string().min(8).max(8192),
  fileIndex: z.number().int().min(0).max(100_000).optional(),
});

export const mediaRoutes = new Hono();

mediaRoutes.post(
  "/resolve",
  bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.body(null, 413) }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      await requireAccess(c);
      // Magnets poll this while searching for peers, hence the roomy limit.
      checkRateLimit(`resolve:${clientIp(c)}`, 60, 10 * 60 * 1000);
      const { url, fileIndex } = resolveSchema.parse(await c.req.json());
      const resolved = await resolveMedia(url, fileIndex);
      if ("needsFileChoice" in resolved || "pending" in resolved) {
        return c.json<ResolveResponse>(resolved);
      }
      const library = await recordPlay({
        url,
        fileIndex: resolved.fileIndex,
        title: resolved.title,
        site: resolved.site,
      });
      return c.json<ResolveResponse>({ ...resolved, ...library });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return routeErrorResponse(
          c,
          new RouteError(400, "请输入完整的视频地址或磁力链接。", "INVALID_URL"),
        );
      }
      return routeErrorResponse(c, error);
    }
  },
);

function method(c: Parameters<Handler>[0]): "GET" | "HEAD" {
  return c.req.method === "HEAD" ? "HEAD" : "GET";
}

const streamHandler: Handler = async (c) => {
  try {
    await requireAccess(c);
    checkRateLimit(`stream:${clientIp(c)}`, 1200, 10 * 60 * 1000);
    const token = c.req.query("token");
    if (!token) {
      throw new RouteError(400, "缺少播放地址。", "MISSING_MEDIA_TOKEN");
    }
    return await proxyMedia(token, c.req.header("range"), method(c));
  } catch (error) {
    return routeErrorResponse(c, error);
  }
};

mediaRoutes.get("/stream", streamHandler);
mediaRoutes.on("HEAD", "/stream", streamHandler);

// HLS remuxed by the media worker. Segment names are relative in the playlist,
// so they resolve to this same route.
const remuxHandler: Handler = async (c) => {
  try {
    await requireAccess(c);
    checkRateLimit(`stream:${clientIp(c)}`, 1200, 10 * 60 * 1000);
    const id = c.req.param("id") || "";
    const file = c.req.param("file") || "";
    if (!/^[0-9a-f]{24}$/.test(id) || !/^[\w.-]{1,40}$/.test(file)) {
      throw new RouteError(404, "播放地址无效。", "NOT_FOUND");
    }
    return await proxyWorkerStream(`/remux/${id}/${file}`, undefined, method(c));
  } catch (error) {
    return routeErrorResponse(c, error);
  }
};
mediaRoutes.get("/remux/:id/:file", remuxHandler);
mediaRoutes.on("HEAD", "/remux/:id/:file", remuxHandler);

const torrentHandler: Handler = async (c) => {
  try {
    await requireAccess(c);
    checkRateLimit(`stream:${clientIp(c)}`, 1200, 10 * 60 * 1000);
    const hash = c.req.param("hash") || "";
    const index = c.req.param("index") || "";
    if (!/^[0-9a-f]{40}$/.test(hash) || !/^\d{1,6}$/.test(index)) {
      throw new RouteError(404, "播放地址无效。", "NOT_FOUND");
    }
    return await proxyWorkerStream(`/torrent/${hash}/${index}`, c.req.header("range"), method(c));
  } catch (error) {
    return routeErrorResponse(c, error);
  }
};
mediaRoutes.get("/torrent/:hash/:index", torrentHandler);
mediaRoutes.on("HEAD", "/torrent/:hash/:index", torrentHandler);

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
