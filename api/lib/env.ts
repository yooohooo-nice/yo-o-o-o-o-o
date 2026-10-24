import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

export const env = {
  appId: required("APP_ID"),
  appSecret: required("APP_SECRET"),
  isProduction: process.env.NODE_ENV === "production",
  databaseUrl: required("DATABASE_URL"),
  // Secure cookies are dropped by browsers over plain http://, which shows up
  // as "correct password, still on the login page". Only turn this off for a
  // LAN/VPN-only deployment that has no HTTPS in front of it.
  cookieSecure:
    process.env.COOKIE_SECURE === "false"
      ? false
      : process.env.NODE_ENV === "production",
};
