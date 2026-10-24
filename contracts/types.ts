export * from "./errors";

export type MediaSite = "jable" | "missav" | "direct";
export type MediaKind = "hls" | "mp4";

export type ResolveMediaResult = {
  title: string;
  sourceUrl: string;
  site: MediaSite;
  kind: MediaKind;
  streamUrl: string;
  posterUrl: string | null;
  expiresAt: number;
  experimental: boolean;
};

export type AccessStatus = {
  authenticated: boolean;
};
