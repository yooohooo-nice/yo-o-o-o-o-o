import type Artplayer from "artplayer";
import type Hls from "hls.js";
import { clamp, formatTime, shouldUseNativeHls } from "./playback";

// A small frame preview above the progress bar and the jog wheel. A second,
// muted <video> of the same stream seeks to the hovered time; the stream is
// served from our own origin, so no thumbnails have to be generated.

export type FramePreview = {
  /** x and bottom are in px relative to the player. */
  show(time: number, x: number, bottom: number, label?: string): void;
  hide(delay?: number): void;
  destroy(): void;
};

const WIDTH = 168;

export function createFramePreview(art: Artplayer, url: string, kind: "hls" | "file"): FramePreview {
  const { $player } = art.template;
  const box = document.createElement("div");
  box.className = "lg-preview";
  box.innerHTML = '<div class="lg-preview-frame"><video muted playsinline preload="metadata"></video></div><span></span>';
  const video = box.querySelector("video")!;
  const caption = box.querySelector("span")!;
  $player.append(box);

  let hls: Hls | null = null;
  let loaded = false;
  let busy = false;
  let wanted = -1;
  let lastSeek = -10;
  let hideTimer = 0;
  let busyTimer = 0;

  const seekNext = () => {
    if (wanted < 0 || busy) return;
    const target = wanted;
    wanted = -1;
    if (Math.abs(target - lastSeek) < 0.5) return;
    busy = true;
    lastSeek = target;
    video.currentTime = target;
    // Never wait forever on a segment that does not come.
    busyTimer = window.setTimeout(() => {
      busy = false;
      seekNext();
    }, 4000);
  };
  video.addEventListener("seeked", () => {
    window.clearTimeout(busyTimer);
    busy = false;
    seekNext();
  });
  video.addEventListener("loadedmetadata", () => {
    busy = false;
    seekNext();
  });

  const load = (start: number) => {
    loaded = true;
    busy = true; // until metadata arrives
    if (kind === "file" || shouldUseNativeHls(video)) {
      video.src = url;
      // iOS only paints frames of a video that has played once.
      void video.play().then(() => video.pause(), () => undefined);
      return;
    }
    void import("hls.js").then(({ default: HlsClass }) => {
      if (!HlsClass.isSupported()) return;
      hls = new HlsClass({
        startLevel: 0,
        capLevelToPlayerSize: true,
        maxBufferLength: 2,
        maxMaxBufferLength: 4,
        backBufferLength: 0,
        startPosition: start,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    });
  };

  const ratio = () => {
    const { videoWidth, videoHeight } = art.template.$video;
    return videoWidth && videoHeight ? clamp(videoWidth / videoHeight, 0.5, 2.4) : 16 / 9;
  };

  return {
    show(time, x, bottom, label) {
      window.clearTimeout(hideTimer);
      if (!loaded) load(time);
      wanted = time;
      seekNext();
      const width = Math.min(WIDTH, $player.clientWidth * 0.42);
      box.style.setProperty("--preview-width", `${width}px`);
      box.style.setProperty("--preview-height", `${width / ratio()}px`);
      box.style.left = `${clamp(x, width / 2 + 6, $player.clientWidth - width / 2 - 6)}px`;
      box.style.bottom = `${bottom}px`;
      caption.textContent = label ?? formatTime(time);
      box.classList.add("is-visible");
    },
    hide(delay = 0) {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => box.classList.remove("is-visible"), delay);
    },
    destroy() {
      window.clearTimeout(hideTimer);
      window.clearTimeout(busyTimer);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
      box.remove();
    },
  };
}

/** Shows the preview while hovering or dragging the progress bar (or swiping the video). */
export function progressPreview(preview: FramePreview) {
  return (art: Artplayer) => {
    const { $player, $progress } = art.template;
    art.on("setBar", (type, percentage, event) => {
      const duration = art.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      if (type === "hover" && percentage <= 0) {
        preview.hide();
        return;
      }
      if (type !== "hover" && !(type === "played" && event)) return;
      const player = $player.getBoundingClientRect();
      const bar = $progress.getBoundingClientRect();
      const time = percentage * duration;
      if (bar.width > 0) {
        preview.show(time, bar.left - player.left + bar.width * percentage, player.bottom - bar.top + 12);
      } else {
        // Controls hidden (e.g. swiping on the video): centre it.
        preview.show(time, player.width / 2, player.height / 2 - 40);
      }
      if (type === "played") preview.hide(900);
    });
    return { name: "progressPreview" };
  };
}
