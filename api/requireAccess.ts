import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { validateAccessSession } from "./access";
import { RouteError } from "./routeUtils";

export const ACCESS_COOKIE = "lg_access";

export function accessTokenFromRequest(c: Context): string | undefined {
  return getCookie(c, ACCESS_COOKIE);
}

export async function requireAccess(c: Context): Promise<void> {
  const valid = await validateAccessSession(accessTokenFromRequest(c));
  if (!valid) {
    throw new RouteError(401, "访问已过期，请重新输入密码。", "ACCESS_REQUIRED");
  }
}
