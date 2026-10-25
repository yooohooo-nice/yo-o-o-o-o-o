import type Artplayer from "artplayer";
import type { FramePreview } from "./framePreview";
import { haptic } from "./haptics";
import { clamp, formatTime } from "./playback";

// A thumbwheel for scrubbing in fullscreen: drag the ridges left or right
// to go back or forward. A full-width drag covers about 1/40 of the video
// (10 s to 3 min) at a calm pace; faster drags go further, slow ones are
// fine-grained, and a flick keeps spinning for a moment. Every notch ticks.

const NOTCH = 12; // px between ridges
const FRICTION = 0.93;

export function jogWheel(preview: FramePreview) {
  return (art: Artplayer) => {
    const { $player } = art.template;
    const wheel = document.createElement("div");
    wheel.className = "lg-wheel";
    wheel.setAttribute("role", "slider");
    wheel.setAttribute("aria-label", "进度波轮：左右拨动快退快进");
    wheel.innerHTML = '<div class="lg-wheel-ridges"></div><div class="lg-wheel-mark"></div>';
    $player.append(wheel);

    let active = false;
    let start = 0;
    let target = 0;
    let offset = 0;
    let notch = 0;
    let atEdge = false;
    let velocity = 0; // px per ms
    let pointer: number | null = null;
    let lastX = 0;
    let lastT = 0;
    let frame = 0;
    let wheelTimer = 0;

    const secondsPerWidth = () => clamp(art.duration / 40, 10, 180);
    // Slow drags fine-tune, fast ones travel: 0.15x at a crawl up to 3x.
    const pace = (speed: number) => clamp(Math.abs(speed) / 0.6, 0.15, 3);

    const showPreview = () => {
      const player = $player.getBoundingClientRect();
      const box = wheel.getBoundingClientRect();
      const diff = target - start;
      const sign = diff >= 0 ? "+" : "−";
      preview.show(
        target,
        box.left - player.left + box.width / 2,
        player.bottom - box.top + 10,
        `${formatTime(target)} / ${formatTime(art.duration)}  ${sign}${formatTime(Math.abs(diff))}`,
      );
    };

    const begin = () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(wheelTimer);
      if (active) return;
      active = true;
      start = target = art.currentTime;
      atEdge = false;
      wheel.classList.add("is-active");
    };

    const turn = (dx: number, speed: number) => {
      const duration = art.duration;
      if (!Number.isFinite(duration) || duration <= 0 || !dx) return;
      const width = wheel.clientWidth || 300;
      const next = clamp(target + (dx / width) * secondsPerWidth() * pace(speed), 0, duration);
      const edge = next <= 0 || next >= duration;
      if (edge && !atEdge) haptic("bump");
      atEdge = edge;
      target = next;
      offset += dx;
      wheel.style.setProperty("--wheel-offset", `${offset}px`);
      notch += Math.abs(dx);
      if (notch >= NOTCH && !edge) {
        notch %= NOTCH;
        haptic("tick");
      }
      showPreview();
    };

    const commit = () => {
      if (!active) return;
      active = false;
      wheel.classList.remove("is-active");
      art.seek = target;
      preview.hide(600);
    };

    const coast = () => {
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(48, now - last);
        last = now;
        velocity *= Math.pow(FRICTION, dt / 16);
        if (Math.abs(velocity) < 0.04) {
          commit();
          return;
        }
        turn(velocity * dt, velocity);
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    const stop = (event: Event) => event.stopPropagation();
    for (const type of ["click", "dblclick", "touchstart", "touchmove", "touchend", "mousedown"]) {
      art.proxy(wheel, type, stop);
    }

    art.proxy(wheel, "pointerdown", (event: Event) => {
      const e = event as PointerEvent;
      if (art.isLock) return;
      e.preventDefault();
      begin();
      pointer = e.pointerId;
      wheel.setPointerCapture(e.pointerId);
      lastX = e.clientX;
      lastT = e.timeStamp;
      velocity = 0;
      showPreview();
    });
    art.proxy(wheel, "pointermove", (event: Event) => {
      const e = event as PointerEvent;
      if (e.pointerId !== pointer) return;
      const dx = e.clientX - lastX;
      const dt = Math.max(1, e.timeStamp - lastT);
      lastX = e.clientX;
      lastT = e.timeStamp;
      velocity = velocity * 0.5 + (dx / dt) * 0.5;
      turn(dx, velocity);
    });
    const release = (event: Event) => {
      const e = event as PointerEvent;
      if (e.pointerId !== pointer) return;
      pointer = null;
      // A pause before letting go means "stop here", not a flick.
      if (e.timeStamp - lastT > 80) velocity = 0;
      if (Math.abs(velocity) > 0.35) coast();
      else commit();
    };
    art.proxy(wheel, "pointerup", release);
    art.proxy(wheel, "pointercancel", release);

    // Mouse wheel / trackpad over the wheel scrubs too.
    art.proxy(wheel, "wheel", (event: Event) => {
      const e = event as WheelEvent;
      e.preventDefault();
      begin();
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : -e.deltaY;
      turn(dx, dx / 16);
      wheelTimer = window.setTimeout(commit, 400);
    });

    return { name: "jogWheel" };
  };
}
