import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  addOfflineDownload,
  driveStatus,
  listDrive,
  offlineTasks,
} from "../pikpakDrive";
import { requireAccess } from "../requireAccess";
import { RouteError, checkRateLimit, clientIp, routeErrorResponse } from "../routeUtils";

const offlineSchema = z.object({ url: z.string().min(8).max(8192) });

export const pikpakRoutes = new Hono();

pikpakRoutes.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.body(null, 413) }));
pikpakRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  try {
    await requireAccess(c);
    checkRateLimit(`pikpak:${clientIp(c)}`, 300, 10 * 60 * 1000);
  } catch (error) {
    return routeErrorResponse(c, error);
  }
  await next();
});

pikpakRoutes.get("/status", async (c) => {
  try {
    return c.json(await driveStatus());
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});

pikpakRoutes.get("/list", async (c) => {
  try {
    const path = (c.req.query("path") || "/").slice(0, 2048);
    const refresh = c.req.query("refresh") === "1";
    return c.json({ items: await listDrive(path, refresh) });
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});

pikpakRoutes.post("/offline", async (c) => {
  try {
    const body = offlineSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      throw new RouteError(400, "请粘贴磁力链接或下载地址。", "INVALID_OFFLINE_URL");
    }
    await addOfflineDownload(body.data.url);
    return c.json({ ok: true });
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});

pikpakRoutes.get("/tasks", async (c) => {
  try {
    return c.json({ tasks: await offlineTasks() });
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});
