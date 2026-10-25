// Short taps for the jog wheel. Android has navigator.vibrate(); iOS Safari
// does not, but toggling a native switch control (iOS 18+) gives a light
// system tap, so that is used there instead. Anything else stays silent.

let iosSwitch: HTMLLabelElement | null = null;
let lastTick = 0;

function iosTap() {
  if (!iosSwitch) {
    iosSwitch = document.createElement("label");
    iosSwitch.setAttribute("aria-hidden", "true");
    iosSwitch.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.tabIndex = -1;
    input.setAttribute("switch", "");
    iosSwitch.append(input);
    document.body.append(iosSwitch);
  }
  iosSwitch.click();
}

/** "tick" for each wheel notch (rate-limited), "bump" at the start or end. */
export function haptic(kind: "tick" | "bump" = "tick") {
  const now = performance.now();
  if (kind === "tick" && now - lastTick < 28) return;
  lastTick = now;
  if (typeof navigator.vibrate === "function") {
    navigator.vibrate(kind === "tick" ? 4 : 20);
  } else {
    iosTap();
  }
}
