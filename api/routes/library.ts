import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  clearHistory,
  listLibrary,
  removeItem,
  saveProgress,
  setFavorite,
} from "../library";
import { requireAccess } from "../requireAccess";
import { RouteError, checkRateLimit, clientIp, routeErrorResponse } from "../routeUtils";

const idSchema = z.string().regex(/^[0-9a-f]{64}$/);
const progressSchema = z.object({
  id: idSchema,
  position: z.number().min(0).max(1_000_000),
  duration: z.number().min(0).max(1_000_000),
});
const favoriteSchema = z.object({ id: idSchema, favorite: z.boolean() });

export const libraryRoutes = new Hono();

libraryRoutes.use("*", bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.body(null, 413) }));
libraryRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  try {
    await requireAccess(c);
    checkRateLimit(`library:${clientIp(c)}`, 600, 10 * 60 * 1000);
  } catch (error) {
    return routeErrorResponse(c, error);
  }
  await next();
});

function badRequest() {
  return new RouteError(400, "请求参数不正确。", "INVALID_LIBRARY_REQUEST");
}

libraryRoutes.get("/", async (c) => {
  try {
    return c.json(await listLibrary());
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});

libraryRoutes.post("/progress", async (c) => {
  try {
    const body = progressSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw badRequest();
    await saveProgress(body.data.id, body.data.position, body.data.duration);
    return c.json({ ok: true });
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});

libraryRoutes.post("/favorite", async (c) => {
  try {
    const body = favoriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw badRequest();
    await setFavorite(body.data.id, body.data.favorite);
    return c.json({ ok: true });
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});

libraryRoutes.delete("/history", async (c) => {
  try {
    await clearHistory();
    return c.json({ ok: true });
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});

libraryRoutes.delete("/:id", async (c) => {
  try {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) throw badRequest();
    await removeItem(id.data);
    return c.json({ ok: true });
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});
