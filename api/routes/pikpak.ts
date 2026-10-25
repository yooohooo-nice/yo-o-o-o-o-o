import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { driveStatus, listDrive } from "../pikpakDrive";
import { requireAccess } from "../requireAccess";
import { checkRateLimit, clientIp, routeErrorResponse } from "../routeUtils";

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
