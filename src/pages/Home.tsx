import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  Clock3,
  Link2,
  LoaderCircle,
  LogOut,
  Play,
  ShieldCheck,
  Star,
} from "lucide-react";
import { AccessGate } from "@/components/AccessGate";
import { InstallHint } from "@/components/InstallHint";
import { LibraryPanel } from "@/components/LibraryPanel";
import { TorrentPicker } from "@/components/TorrentPicker";
import { VideoPlayer } from "@/components/VideoPlayer";
import { ApiRequestError, apiFetch } from "@/lib/api";
import type {
  AccessStatus,
  LibraryItem,
  LibraryResponse,
  ResolveMediaResult,
  ResolveResponse,
  TorrentChoice,
} from "@contracts/types";

const DEMO_STREAM =
  "https://test-streams.mux.dev/x36xhzz/url_2/193039199_mp4_h264_aac_ld_7.m3u8";
const EMPTY_LIBRARY: LibraryResponse = { recent: [], favorites: [] };

type AuthState = "loading" | "gate" | "ready" | "error";

/**
 * A link handed over by the share sheet (Android share target) or an iOS
 * Shortcut: /share?text=… or /?url=…. Shared text often wraps the link in
 * other words, so pick the first magnet or http(s) link out of it.
 */
function sharedLinkFromLocation(): string | null {
  const params = new URLSearchParams(window.location.search);
  const raw = [params.get("url"), params.get("text"), params.get("title")]
    .filter(Boolean)
    .join(" ");
  const match = raw.match(/magnet:\?[^\s"'<>]+|https?:\/\/[^\s"'<>]+/i);
  return match ? match[0] : null;
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "媒体地址";
  }
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function BootScreen() {
  return (
    <div className="boot-screen" role="status" aria-label="正在检查访问状态">
      <div className="boot-panel boot-panel-left" />
      <div className="boot-panel boot-panel-right" />
      <div className="boot-content">
        <span className="boot-wordmark">LIUGUANG</span>
        <div className="boot-bars" aria-hidden="true"><i /><i /><i /></div>
      </div>
    </div>
  );
}

export default function Home() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [authError, setAuthError] = useState("");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ResolveMediaResult | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [choice, setChoice] = useState<TorrentChoice | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [library, setLibrary] = useState<LibraryResponse>(EMPTY_LIBRARY);
  const [loggingOut, setLoggingOut] = useState(false);
  const requestRef = useRef(0);
  const playerRef = useRef<HTMLElement>(null);
  const sharedLinkRef = useRef(sharedLinkFromLocation());

  const checkSession = useCallback(async () => {
    setAuthState("loading");
    setAuthError("");
    try {
      const status = await apiFetch<AccessStatus>("/api/access/status");
      setAuthState(status.authenticated ? "ready" : "gate");
    } catch (reason) {
      setAuthError(reason instanceof Error ? reason.message : "无法连接服务。");
      setAuthState("error");
    }
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      setLibrary(await apiFetch<LibraryResponse>("/api/library"));
    } catch {
      // The list is secondary; playing still works without it.
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  function scrollToPlayer() {
    requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      playerRef.current?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });
  }

  async function resolveUrl(target: string, fileIndex?: number) {
    const cleanUrl = target.trim();
    if (!cleanUrl) {
      setError("请先粘贴一个视频地址或磁力链接。");
      return;
    }
    const requestId = ++requestRef.current;
    setResolving(true);
    setError("");
    setResult(null);
    setChoice(null);
    scrollToPlayer();
    setSearchStatus(/^magnet:/i.test(cleanUrl) ? "正在 BT 网络中寻找下载源…" : "");
    try {
      let resolved = await apiFetch<ResolveResponse>("/api/media/resolve", {
        method: "POST",
        body: JSON.stringify({ url: cleanUrl, fileIndex }),
      });
      // A magnet still looking for peers: ask again until the server has the
      // file list (it gives up by itself after a few minutes).
      while ("pending" in resolved) {
        if (requestId !== requestRef.current) return;
        setSearchStatus(
          resolved.peers > 0
            ? `正在获取种子信息，已连接 ${resolved.peers} 个用户…`
            : "正在 BT 网络中寻找下载源…",
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (requestId !== requestRef.current) return;
        resolved = await apiFetch<ResolveResponse>("/api/media/resolve", {
          method: "POST",
          body: JSON.stringify({ url: cleanUrl, fileIndex }),
        });
      }
      if (requestId !== requestRef.current) return;
      if ("needsFileChoice" in resolved) {
        setChoice(resolved);
        return;
      }
      setResult(
        cleanUrl === DEMO_STREAM
          ? { ...resolved, title: "播放自检 · Mux 公开测试流" }
          : resolved,
      );
      setFavorite(resolved.favorite);
      void loadLibrary();
    } catch (reason) {
      if (requestId !== requestRef.current) return;
      if (reason instanceof ApiRequestError && reason.status === 401) {
        setAuthState("gate");
        return;
      }
      setError(reason instanceof Error ? reason.message : "解析失败，请稍后重试。");
    } finally {
      if (requestId === requestRef.current) setResolving(false);
    }
  }

  // Once logged in: load the library, and play a link handed over by the
  // share sheet, then tidy the address bar so a reload does not replay it.
  useEffect(() => {
    if (authState !== "ready") return;
    void loadLibrary();
    const shared = sharedLinkRef.current;
    if (shared) {
      sharedLinkRef.current = null;
      window.history.replaceState(null, "", "/");
      setUrl(shared);
      void resolveUrl(shared);
    }
    // resolveUrl is recreated each render; running once per login is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, loadLibrary]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void resolveUrl(url);
  }

  async function handleLogout() {
    setLoggingOut(true);
    setError("");
    requestRef.current += 1;
    setResolving(false);
    try {
      await apiFetch("/api/access/logout", { method: "POST" });
      setResult(null);
      setChoice(null);
      setLibrary(EMPTY_LIBRARY);
      setAuthState("gate");
    } catch {
      setError("退出失败，服务端会话可能仍然有效。请检查网络后再次点击退出。");
    } finally {
      setLoggingOut(false);
    }
  }

  async function toggleFavorite() {
    if (!result) return;
    const next = !favorite;
    setFavorite(next);
    try {
      await apiFetch("/api/library/favorite", {
        method: "POST",
        body: JSON.stringify({ id: result.libraryId, favorite: next }),
      });
      void loadLibrary();
    } catch {
      setFavorite(!next);
    }
  }

  function playItem(item: LibraryItem) {
    setUrl(item.url);
    void resolveUrl(item.url, item.fileIndex ?? undefined);
  }

  async function removeItem(item: LibraryItem) {
    await apiFetch(`/api/library/${item.id}`, { method: "DELETE" }).catch(() => undefined);
    void loadLibrary();
  }

  async function clearHistory() {
    await apiFetch("/api/library/history", { method: "DELETE" }).catch(() => undefined);
    void loadLibrary();
  }

  if (authState === "loading") return <BootScreen />;
  if (authState === "gate") {
    return <AccessGate onAuthenticated={() => setAuthState("ready")} />;
  }
  if (authState === "error") {
    return (
      <main className="service-error">
        <AlertCircle size={30} strokeWidth={1.4} />
        <h1>暂时无法连接服务</h1>
        <p>{authError}</p>
        <button className="primary-button" type="button" onClick={() => void checkSession()}>
          重新连接
        </button>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">流</span>
          <span>流光播放器</span>
        </div>
        <div className="header-actions">
          <span className="header-status"><i />密码访问 · 18+</span>
          <button
            className="icon-button logout-button"
            type="button"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
            aria-label="退出访问"
            title="退出访问"
          >
            {loggingOut ? <LoaderCircle className="spin" size={19} /> : <LogOut size={19} />}
          </button>
        </div>
      </header>

      <main>
        <InstallHint />
        <section className="hero-grid" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="utility-label">PRIVATE STREAM · ANY SCREEN</p>
            <h1 id="hero-title">把链接，<br />变成画面。</h1>
            <p className="hero-description">
              无需安装应用。粘贴视频页或媒体直链，由服务端实时解析并代理播放。
            </p>
            <div className="hero-meta" aria-label="服务特点">
              <span>NO APP</span><span>NO VIDEO STORAGE</span><span>HLS / MP4</span>
            </div>
          </div>

          <form className="resolver-form glass-surface" onSubmit={handleSubmit}>
            <div className="resolver-heading">
              <span className="live-dot" aria-hidden="true" />
              <span>新建播放</span>
            </div>
            <label className="field-label" htmlFor="media-url">视频地址</label>
            <div className="url-field">
              <Link2 size={19} aria-hidden="true" />
              <input
                id="media-url"
                type="text"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="粘贴视频地址、网页或磁力链接"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                disabled={resolving}
                aria-describedby="url-help"
              />
            </div>
            <p id="url-help" className="field-help">
              支持 Jable、MissAV 网页，M3U8／MP4／MKV／FLV 等直链，以及磁力链接和种子地址。
            </p>

            {error && (
              <div className="resolve-error" role="alert">
                <AlertCircle size={18} />
                <p>{error}</p>
              </div>
            )}

            <button className="primary-button resolve-button" type="submit" disabled={resolving}>
              {resolving ? <LoaderCircle className="spin" size={19} /> : <Play size={18} fill="currentColor" />}
              {resolving ? "正在解析…" : "解析并播放"}
            </button>
            <button
              className="self-test-button"
              type="button"
              disabled={resolving}
              onClick={() => {
                setUrl(DEMO_STREAM);
                void resolveUrl(DEMO_STREAM);
              }}
            >
              <ShieldCheck size={17} />没有链接？运行播放自检<ArrowRight size={16} />
            </button>
          </form>
        </section>

        <section className="player-section" ref={playerRef} aria-labelledby="player-heading">
          <div className="section-heading">
            <div>
              <p className="utility-label">NOW PLAYING</p>
              <h2 id="player-heading">{result ? result.title : choice ? "选择要播放的文件" : "等待一个视频链接"}</h2>
            </div>
            {result && (
              <div className="now-playing-actions">
                <button
                  className={`icon-button favorite-button ${favorite ? "is-active" : ""}`}
                  type="button"
                  onClick={() => void toggleFavorite()}
                  aria-pressed={favorite}
                  aria-label={favorite ? "取消收藏" : "收藏"}
                  title={favorite ? "取消收藏" : "收藏"}
                >
                  <Star size={19} fill={favorite ? "currentColor" : "none"} />
                </button>
                <span className="media-badge">
                  {result.site === "torrent"
                    ? "BT"
                    : result.site === "direct"
                      ? "媒体直链"
                      : result.experimental
                        ? "实验性源站适配"
                        : result.site}
                </span>
              </div>
            )}
          </div>

          {result ? (
            <VideoPlayer result={result} />
          ) : choice ? (
            <TorrentPicker
              choice={choice}
              onPick={(fileIndex) => void resolveUrl(choice.sourceUrl, fileIndex)}
              onCancel={() => setChoice(null)}
            />
          ) : (
            <div className="empty-player" aria-live="polite">
              {resolving ? (
                <>
                  <div className="resolve-bars" aria-hidden="true"><i /><i /><i /><i /></div>
                  <p>{searchStatus || "正在解析"}</p>
                  <span>磁力链接需要先找到下载源，冷门资源可能要等一两分钟</span>
                </>
              ) : (
                <>
                  <Play size={42} strokeWidth={1} aria-hidden="true" />
                  <p>解析完成后，视频会在这里播放</p>
                  <span>播放器支持手机全屏与系统原生控制</span>
                </>
              )}
            </div>
          )}

          {result && (
            <div className="playback-meta">
              <span>{result.site === "torrent" ? "BT 边下边播" : hostOf(result.sourceUrl)}</span>
              <span><Clock3 size={14} />播放地址有效至 {formatClock(result.expiresAt)}</span>
            </div>
          )}
        </section>

        <LibraryPanel
          library={library}
          disabled={resolving}
          onPlay={playItem}
          onRemove={(item) => void removeItem(item)}
          onClearHistory={() => void clearHistory()}
        />
      </main>

      <footer className="site-footer">
        <div className="brand-lockup footer-brand">
          <span className="brand-mark" aria-hidden="true">流</span>
          <span>流光</span>
        </div>
        <p>仅限成年人使用。请仅访问自己有权观看的内容，并遵守源站条款与当地法律。</p>
        <p className="footer-tech">实时代理 · 不存储视频 · 不开放公共下载 · {new Date().getFullYear()}</p>
      </footer>
    </div>
  );
}
