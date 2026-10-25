import { useEffect, useRef, useState } from "react";
import Artplayer from "artplayer";
import type Hls from "hls.js";
import { AlertCircle, RotateCcw } from "lucide-react";
import type { ResolveMediaResult } from "@contracts/types";

type VideoPlayerProps = {
  result: ResolveMediaResult;
};

const PROGRESS_INTERVAL_MS = 15_000;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SEEK = 10;

// Our double-tap plugin decides by tap position (left/right seek, middle
// play/pause); ArtPlayer's own double-tap-to-play would toggle on every one.
Artplayer.MOBILE_DBCLICK_PLAY = false;

function shouldUseNativeHls(video: HTMLVideoElement): boolean {
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

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function saveProgress(
  id: string,
  position: number,
  duration: number,
  beacon = false
) {
  if (!Number.isFinite(position) || position <= 0) return;
  const body = JSON.stringify({
    id,
    position,
    duration: Number.isFinite(duration) ? duration : 0,
  });
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon(
      "/api/library/progress",
      new Blob([body], { type: "application/json" })
    );
    return;
  }
  void fetch("/api/library/progress", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Progress is a convenience; playback must not care if a save fails.
  });
}

// Double-tap the left or right third to jump 10 seconds, the middle to
// play/pause — the gesture people know from phone video apps.
function doubleTapSeek(art: Artplayer) {
  if (!("ontouchstart" in window)) return;
  const { $player, $video, $mask } = art.template;
  let lastTap = 0;
  let startX = 0;
  let startY = 0;
  // ArtPlayer's proxy() types handlers as plain Event; these are touch events.
  const onStart = (event: Event) => {
    const touch = (event as TouchEvent).touches?.[0];
    startX = touch?.clientX ?? 0;
    startY = touch?.clientY ?? 0;
  };
  const onEnd = (event: Event) => {
    const touch = (event as TouchEvent).changedTouches?.[0];
    if (
      !touch ||
      Math.hypot(touch.clientX - startX, touch.clientY - startY) > 12
    )
      return;
    const now = Date.now();
    if (now - lastTap > DOUBLE_TAP_MS) {
      lastTap = now;
      return;
    }
    lastTap = 0;
    const rect = $player.getBoundingClientRect();
    const ratio = (touch.clientX - rect.left) / rect.width;
    if (ratio < 0.35) {
      art.seek = Math.max(0, art.currentTime - DOUBLE_TAP_SEEK);
      art.notice.show = `« 快退 ${DOUBLE_TAP_SEEK} 秒`;
    } else if (ratio > 0.65) {
      art.seek = Math.min(
        art.duration || Infinity,
        art.currentTime + DOUBLE_TAP_SEEK
      );
      art.notice.show = `快进 ${DOUBLE_TAP_SEEK} 秒 »`;
    } else {
      art.toggle();
    }
  };
  for (const target of [$video, $mask]) {
    art.proxy(target, "touchstart", onStart);
    art.proxy(target, "touchend", onEnd);
  }
  return { name: "doubleTapSeek" };
}

export function VideoPlayer({ result }: VideoPlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setError("");
    let hls: Hls | null = null;
    const startAt = result.resumeAt ?? 0;

    const playM3u8 = (video: HTMLVideoElement, url: string) => {
      if (shouldUseNativeHls(video)) {
        video.src = url;
        return;
      }
      void import("hls.js")
        .then(({ default: HlsClass }) => {
          if (!HlsClass.isSupported()) {
            if (video.canPlayType("application/vnd.apple.mpegurl"))
              video.src = url;
            else
              setError(
                "当前浏览器不支持此 HLS 播放方式，请使用最新版 Safari、Chrome 或 Edge。"
              );
            return;
          }
          hls = new HlsClass({
            enableWorker: true,
            backBufferLength: 30,
            maxBufferLength: 30,
            maxBufferSize: 40 * 1000 * 1000,
            // A playlist that is still being converted looks "live" to hls.js,
            // which would otherwise jump to its end.
            startPosition: result.converting ? startAt : -1,
          });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(HlsClass.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            if (
              data.type === HlsClass.ErrorTypes.NETWORK_ERROR &&
              result.converting
            ) {
              // The next segment may simply not be converted yet.
              hls?.startLoad();
              return;
            }
            setError("播放连接中断。请检查网络，或重新解析视频地址后重试。");
            hls?.destroy();
            hls = null;
          });
        })
        .catch(() => setError("播放引擎加载失败，请检查网络后重新加载。"));
    };

    const art = new Artplayer({
      container: host,
      url: result.streamUrl,
      type: result.kind === "hls" ? "m3u8" : "",
      poster: result.posterUrl || "",
      theme: "#f1f1f1",
      lang: "zh-cn",
      volume: 1,
      autoplay: true,
      autoSize: false,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      pip: true,
      airplay: true,
      hotkey: true,
      mutex: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      playsInline: true,
      lock: true,
      gesture: true,
      fastForward: true,
      autoOrientation: true,
      // Resume comes from the server so it follows you across devices.
      autoPlayback: false,
      backdrop: true,
      moreVideoAttr: { preload: "auto" },
      customType: { m3u8: playM3u8 },
      plugins: [doubleTapSeek],
    });

    let resumed = false;
    art.on("video:loadedmetadata", () => {
      if (resumed) return;
      resumed = true;
      if (startAt > 0) {
        art.seek = startAt;
        art.notice.show = `已从 ${formatTime(startAt)} 继续播放`;
      } else if (result.converting && art.currentTime > 1) {
        // Safari opens a still-growing playlist at its end; start from the top.
        art.seek = 0;
      }
    });
    art.on("video:error", () => {
      if (hls) return; // hls.js reports its own errors
      setError(
        result.kind === "file"
          ? "播放失败：可能是源站拒绝访问、地址过期，或这个文件的编码当前浏览器不支持。"
          : "播放失败，可能是源站拒绝访问、地址过期或网络中断。请重新解析后再试。"
      );
    });

    const report = (beacon = false) =>
      saveProgress(result.libraryId, art.currentTime, art.duration, beacon);
    const timer = window.setInterval(() => {
      if (art.playing) report();
    }, PROGRESS_INTERVAL_MS);
    art.on("pause", () => report());
    art.on("video:ended", () =>
      saveProgress(result.libraryId, art.duration, art.duration)
    );
    const onHide = () => {
      if (document.visibilityState === "hidden") report(true);
    };
    document.addEventListener("visibilitychange", onHide);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
      report(true);
      hls?.destroy();
      art.destroy();
    };
  }, [result, retry]);

  return (
    <>
      <div className="video-frame">
        <div ref={hostRef} className="art-host" />
        {error && (
          <div className="playback-error" role="alert">
            <AlertCircle size={24} strokeWidth={1.5} />
            <p>{error}</p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setRetry(value => value + 1)}
            >
              <RotateCcw size={17} />
              重新加载
            </button>
          </div>
        )}
      </div>
      {result.converting && !error && (
        <p className="converting-note">
          服务器正在转换此视频格式，往后拖动可能需要等待转换完成。
        </p>
      )}
    </>
  );
}
