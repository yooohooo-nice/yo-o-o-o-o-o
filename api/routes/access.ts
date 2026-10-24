import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  assertLoginAllowed,
  clearLoginFailures,
  createAccessSession,
  recordLoginFailure,
  revokeAccessSession,
  validateAccessSession,
  verifyAccessPassword,
} from "../access";
import { env } from "../lib/env";
import {
  ACCESS_COOKIE,
  accessTokenFromRequest,
} from "../requireAccess";
import { RouteError, clientIp, routeErrorResponse } from "../routeUtils";

const loginSchema = z.object({
  password: z.string().min(1).max(200),
  adultConfirmed: z.literal(true),
});

export const accessRoutes = new Hono();

accessRoutes.get("/status", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const authenticated = await validateAccessSession(accessTokenFromRequest(c));
    return c.json({ authenticated });
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});

accessRoutes.post(
  "/login",
  bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.body(null, 413) }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    const ip = clientIp(c);
    try {
      await assertLoginAllowed(ip);
      const body = loginSchema.parse(await c.req.json());
      try {
        verifyAccessPassword(body.password);
      } catch (error) {
        if (error instanceof RouteError && error.status === 401) {
          await recordLoginFailure(ip);
        }
        throw error;
      }

      await clearLoginFailures(ip);
      const session = await createAccessSession();
      setCookie(c, ACCESS_COOKIE, session.token, {
        httpOnly: true,
        sameSite: "Lax",
        secure: env.cookieSecure,
        path: "/",
        maxAge: Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
      });
      return c.json({ authenticated: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return routeErrorResponse(
          c,
          new RouteError(400, "请输入密码，并确认已年满 18 岁。", "INVALID_LOGIN"),
        );
      }
      return routeErrorResponse(c, error);
    }
  },
);

accessRoutes.post("/logout", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    await revokeAccessSession(accessTokenFromRequest(c));
    deleteCookie(c, ACCESS_COOKIE, { path: "/" });
    return c.json({ authenticated: false });
  } catch (error) {
    return routeErrorResponse(c, error);
  }
});
