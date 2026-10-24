import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

const DISMISSED_KEY = "liuguang.install-hint.dismissed";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

// Suggests adding the player to the home screen, so it opens full-screen like
// an app. Android/desktop Chrome offer a real install prompt; iOS only allows
// the manual Share → Add to Home Screen route, so it gets instructions instead.
export function InstallHint() {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(() => isStandalone() || wasDismissed());
  const ios = isIos();

  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallPromptEvent);
    };
    const installed = () => setHidden(true);
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", installed);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable: the hint simply comes back next visit.
    }
    setHidden(true);
  }

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    setInstallEvent(null);
    if (outcome === "accepted") setHidden(true);
  }

  if (hidden || (!ios && !installEvent)) return null;

  return (
    <aside className="install-hint" aria-label="添加到主屏幕">
      <Download size={18} aria-hidden="true" />
      {ios ? (
        <p>
          添加到主屏幕，像 App 一样全屏打开：在 Safari 点底部
          <Share size={15} className="install-hint-share" aria-label="分享" />
          ，再选“添加到主屏幕”。
        </p>
      ) : (
        <p>可以把流光安装到主屏幕，像 App 一样全屏打开。</p>
      )}
      {!ios && installEvent && (
        <button className="secondary-button install-hint-action" type="button" onClick={() => void install()}>
          安装
        </button>
      )}
      <button className="icon-button" type="button" onClick={dismiss} aria-label="不再提示" title="不再提示">
        <X size={17} />
      </button>
    </aside>
  );
}
