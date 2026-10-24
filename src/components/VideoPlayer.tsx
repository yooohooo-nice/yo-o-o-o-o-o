import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import { AlertCircle, LoaderCircle, RotateCcw } from "lucide-react";
import type { ResolveMediaResult } from "@contracts/types";

type VideoPlayerProps = {
  result: ResolveMediaResult;
};

function shouldUseNativeHls(video: HTMLVideoElement): boolean {
  if (!video.canPlayType("application/vnd.apple.mpegurl")) return false;
  const userAgent = navigator.userAgent;
  const appleMobile = /iPad|iPhone|iPod/.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const safari = /safari/i.test(userAgent) &&
    !/chrome|chromium|crios|android|edg|opr|fxios/i.test(userAgent);
  return appleMobile || safari;
}

export function VideoPlayer({ result }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let active = true;
    let hls: Hls | null = null;
    setReady(false);
    setError("");

    const handleLoaded = () => {
      if (active) setReady(true);
    };
    const handleVideoError = () => {
      if (!active) return;
      setReady(false);
      setError("播放失败，可能是源站拒绝访问、地址过期或网络中断。请重新解析后再试。");
    };

    video.addEventListener("loadeddata", handleLoaded);
    video.addEventListener("error", handleVideoError);

    if (result.kind === "hls" && shouldUseNativeHls(video)) {
      video.src = result.streamUrl;
      video.load();
    } else if (result.kind === "hls") {
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (!active) return;
          if (!Hls.isSupported()) {
            if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = result.streamUrl;
              video.load();
            } else {
              setError("当前浏览器不支持此 HLS 播放方式，请使用最新版 Safari、Chrome 或 Edge。");
            }
            return;
          }
          hls = new Hls({
            enableWorker: true,
            backBufferLength: 30,
            maxBufferLength: 24,
            maxBufferSize: 30 * 1000 * 1000,
          });
          hls.loadSource(result.streamUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!active || !data.fatal) return;
            setReady(false);
            setError("播放连接中断。请检查网络，或重新解析视频地址后重试。");
            hls?.destroy();
            hls = null;
          });
        })
        .catch(() => {
          if (active) setError("播放引擎加载失败，请检查网络后重新加载。");
        });
    } else {
      video.src = result.streamUrl;
      video.load();
    }

    return () => {
      active = false;
      video.removeEventListener("loadeddata", handleLoaded);
      video.removeEventListener("error", handleVideoError);
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [result.kind, result.streamUrl, retry]);

  return (
    <div className={`video-frame ${ready ? "is-ready" : ""}`} aria-busy={!ready && !error}>
      <video
        ref={videoRef}
        className="video-element"
        controls
        playsInline
        preload="auto"
        poster={result.posterUrl || undefined}
        aria-label={result.title}
      />
      {!ready && !error && (
        <div className="player-state" role="status">
          <LoaderCircle className="spin" size={19} />
          <span>正在建立播放连接</span>
        </div>
      )}
      {error && (
        <div className="playback-error" role="alert">
          <AlertCircle size={24} strokeWidth={1.5} />
          <p>{error}</p>
          <button className="secondary-button" type="button" onClick={() => setRetry((value) => value + 1)}>
            <RotateCcw size={17} />重新加载
          </button>
        </div>
      )}
    </div>
  );
}
