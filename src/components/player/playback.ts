export function shouldUseNativeHls(video: HTMLVideoElement): boolean {
  if (!video.canPlayType("application/vnd.apple.mpegurl")) return false;
  const userAgent = navigator.userAgent;
  const appleMobile =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const safari =
    /safari/i.test(userAgent) &&
    !/chrome|chromium|crios|android|edg|opr|fxios/i.test(userAgent);
  return appleMobile || safari;
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
