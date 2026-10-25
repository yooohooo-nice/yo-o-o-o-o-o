import type Artplayer from "artplayer";
import type { FramePreview } from "./framePreview";
import { haptic } from "./haptics";
import { clamp, formatTime } from "./playback";

// A hidden scrub wheel for fullscreen. At rest it is a thin, faded bar;
// pressing it grows it into a ridged wheel. Vertical by default: push up to
// go forward, down to go back (horizontal: right forward, left back).
// - Pace follows the video: one wheel length covers about 1/40 of it
//   (10 s to 3 min); slow drags fine-tune, fast ones travel, flicks coast.
// - Every notch ticks; the start and end of the video bump.
// - Long-press, then drag: move the wheel anywhere. Double-tap: switch
//   between vertical and horizontal. Both are remembered on this device.

const NOTCH = 10; // px between ridges
const LENGTH = 220; // px, the wheel's length while pressed
const FRICTION = 0.93;
const HOLD_TO_MOVE_MS = 450;
const DOUBLE_TAP_MS = 300;
const STORE_KEY = "liuguang:jog-wheel";

type Axis = "x" | "y";
type Layout = { axis: Axis; x: number; y: number }; // x, y: centre as a fraction of the player

function loadLayout(): Layout {
  const fallback: Layout = { axis: "y", x: 0.9, y: 0.74 };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null") as Partial<Layout> | null;
    if (!saved) return fallback;
    return {
      axis: saved.axis === "x" ? "x" : "y",
      x: clamp(Number(saved.x) || fallback.x, 0.05, 0.95),
      y: clamp(Number(saved.y) || fallback.y, 0.08, 0.92),
    };
  } catch {
    return fallback;
  }
}

function saveLayout(layout: Layout) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(layout));
  } catch {
    // Remembering the position is a convenience.
  }
}

export function jogWheel(preview: FramePreview) {
  return (art: Artplayer) => {
    const { $player } = art.template;
    const wheel = document.createElement("div");
    wheel.className = "lg-wheel";
    wheel.setAttribute("role", "slider");
    wheel.setAttribute("aria-label", "进度波轮：上推快进，下拉快退；长按拖动可移动，双击切换方向");
    wheel.innerHTML =
      '<div class="lg-wheel-body"><div class="lg-wheel-ridges"></div><div class="lg-wheel-mark"></div></div>';
    $player.append(wheel);

    const layout = loadLayout();
    const place = () => {
      wheel.dataset.axis = layout.axis;
      wheel.style.left = `${layout.x * 100}%`;
      wheel.style.top = `${layout.y * 100}%`;
    };
    place();

    let mode: "idle" | "pending" | "scrub" | "move" = "idle";
    let active = false;
    let start = 0;
    let target = 0;
    let offset = 0;
    let notch = 0;
    let atEdge = false;
    let velocity = 0; // px per ms, positive = forward
    let pointer: number | null = null;
    let downX = 0;
    let downY = 0;
    let lastPos = 0;
    let lastT = 0;
    let lastTap = 0;
    let frame = 0;
    let holdTimer = 0;
    let settleTimer = 0;
    let wheelTimer = 0;

    const secondsPerLength = () => clamp(art.duration / 40, 10, 180);
    // Slow drags fine-tune, fast ones travel: 0.15x at a crawl up to 3x.
    const pace = (speed: number) => clamp(Math.abs(speed) / 0.6, 0.15, 3);
    // Forward is up (vertical) or right (horizontal).
    const along = (e: PointerEvent) => (layout.axis === "y" ? -e.clientY : e.clientX);

    const expand = (on: boolean) => {
      window.clearTimeout(settleTimer);
      if (on) wheel.classList.add("is-open");
      // Linger a moment after a change, then shrink back to the thin bar.
      else settleTimer = window.setTimeout(() => wheel.classList.remove("is-open"), 700);
    };

    const showPreview = () => {
      const width = $player.clientWidth;
      const height = $player.clientHeight;
      const cx = layout.x * width;
      const cy = layout.y * height;
      const reach = layout.axis === "y" ? LENGTH / 2 : 26;
      const diff = target - start;
      preview.show(
        target,
        cx,
        height - cy + reach + 12,
        `${formatTime(target)} / ${formatTime(art.duration)}  ${diff >= 0 ? "+" : "−"}${formatTime(Math.abs(diff))}`,
      );
    };

    const begin = () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(wheelTimer);
      expand(true);
      if (active) return;
      active = true;
      start = target = art.currentTime;
      atEdge = false;
    };

    const turn = (delta: number, speed: number) => {
      const duration = art.duration;
      if (!Number.isFinite(duration) || duration <= 0 || !delta) return;
      const next = clamp(target + (delta / LENGTH) * secondsPerLength() * pace(speed), 0, duration);
      const edge = next <= 0 || next >= duration;
      if (edge && !atEdge) haptic("bump");
      atEdge = edge;
      target = next;
      // Ridges follow the finger: up/right moves them that way.
      offset += layout.axis === "y" ? -delta : delta;
      wheel.style.setProperty("--wheel-offset", `${offset}px`);
      notch += Math.abs(delta);
      if (notch >= NOTCH && !edge) {
        notch %= NOTCH;
        haptic("tick");
      }
      showPreview();
    };

    const finish = () => {
      if (active) {
        active = false;
        if (Math.abs(target - start) > 0.05) {
          art.seek = target;
          preview.hide(600);
        } else {
          preview.hide();
        }
      }
      expand(false);
    };

    const coast = () => {
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(48, now - last);
        last = now;
        velocity *= Math.pow(FRICTION, dt / 16);
        if (Math.abs(velocity) < 0.04) {
          finish();
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
      if (art.isLock || pointer !== null) return;
      e.preventDefault();
      pointer = e.pointerId;
      wheel.setPointerCapture(e.pointerId);
      downX = e.clientX;
      downY = e.clientY;
      lastPos = along(e);
      lastT = e.timeStamp;
      velocity = 0;
      mode = "pending";
      begin();
      showPreview();
      holdTimer = window.setTimeout(() => {
        if (mode !== "pending") return;
        // Held still: pick the wheel up to move it.
        mode = "move";
        active = false;
        preview.hide();
        wheel.classList.add("is-moving");
        haptic("bump");
      }, HOLD_TO_MOVE_MS);
    });

    art.proxy(wheel, "pointermove", (event: Event) => {
      const e = event as PointerEvent;
      if (e.pointerId !== pointer) return;
      if (mode === "move") {
        const box = $player.getBoundingClientRect();
        layout.x = clamp((e.clientX - box.left) / box.width, 0.05, 0.95);
        layout.y = clamp((e.clientY - box.top) / box.height, 0.08, 0.92);
        place();
        return;
      }
      if (mode === "pending") {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) < 6) return;
        window.clearTimeout(holdTimer);
        mode = "scrub";
      }
      const pos = along(e);
      const delta = pos - lastPos;
      const dt = Math.max(1, e.timeStamp - lastT);
      lastPos = pos;
      lastT = e.timeStamp;
      velocity = velocity * 0.5 + (delta / dt) * 0.5;
      turn(delta, velocity);
    });

    const release = (event: Event) => {
      const e = event as PointerEvent;
      if (e.pointerId !== pointer) return;
      pointer = null;
      window.clearTimeout(holdTimer);
      const was = mode;
      mode = "idle";
      if (was === "move") {
        wheel.classList.remove("is-moving");
        saveLayout(layout);
        expand(false);
        return;
      }
      if (was === "pending") {
        // A tap. Two in a row switch between vertical and horizontal.
        finish();
        if (e.timeStamp - lastTap < DOUBLE_TAP_MS) {
          lastTap = 0;
          layout.axis = layout.axis === "y" ? "x" : "y";
          place();
          saveLayout(layout);
          haptic("bump");
          art.notice.show = layout.axis === "y" ? "波轮：上下拨动" : "波轮：左右拨动";
        } else {
          lastTap = e.timeStamp;
        }
        return;
      }
      // A pause before letting go means "stop here", not a flick.
      if (e.timeStamp - lastT > 80) velocity = 0;
      if (Math.abs(velocity) > 0.35) coast();
      else finish();
    };
    art.proxy(wheel, "pointerup", release);
    art.proxy(wheel, "pointercancel", release);

    // Mouse wheel / trackpad over it scrubs too (scroll up = forward).
    art.proxy(wheel, "wheel", (event: Event) => {
      const e = event as WheelEvent;
      e.preventDefault();
      begin();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : -e.deltaY;
      turn(delta, delta / 16);
      wheelTimer = window.setTimeout(finish, 400);
    });

    return { name: "jogWheel" };
  };
}
