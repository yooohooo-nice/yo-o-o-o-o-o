import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertCircle,
  ArrowRight,
  Clock3,
  History,
  Link2,
  LoaderCircle,
  LogOut,
  Play,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { AccessGate } from "@/components/AccessGate";
import { InstallHint } from "@/components/InstallHint";
import { VideoPlayer } from "@/components/VideoPlayer";
import { ApiRequestError, apiFetch } from "@/lib/api";
import type {
  AccessStatus,
  ResolveMediaResult,
} from "@contracts/types";

const DEMO_STREAM =
  "https://test-streams.mux.dev/x36xhzz/url_2/193039199_mp4_h264_aac_ld_7.m3u8";
const HISTORY_KEY = "liuguang.recent.v1";

type AuthState = "loading" | "gate" | "ready" | "error";
type RecentItem = {
  url: string;
  title: string;
  site: string;
  resolvedAt: number;
};

function readHistory(): RecentItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item.url === "string" && typeof item.title === "string")
      .slice(0, 4);
  } catch {
    return [];
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "媒体地址";
  }
}

function formatTime(value: number): string {
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
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<RecentItem[]>(readHistory);
  const [loggingOut, setLoggingOut] = useState(false);
  const requestRef = useRef(0);
  const playerRef = useRef<HTMLElement>(null);

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

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  async function resolveUrl(target: string) {
    const cleanUrl = target.trim();
    if (!cleanUrl) {
      setError("请先粘贴一个视频地址。");
      return;
    }
    const requestId = ++requestRef.current;
    setResolving(true);
    setError("");
    setResult(null);
    try {
      const resolved = await apiFetch<ResolveMediaResult>("/api/media/resolve", {
        method: "POST",
        body: JSON.stringify({ url: cleanUrl }),
      });
      if (requestId !== requestRef.current) return;
      const displayResult = cleanUrl === DEMO_STREAM
        ? { ...resolved, title: "播放自检 · Mux 公开测试流" }
        : resolved;
      setResult(displayResult);
      const nextItem: RecentItem = {
        url: cleanUrl,
        title: displayResult.title,
        site: resolved.site,
        resolvedAt: Date.now(),
      };
      setRecent((current) => {
        const next = [nextItem, ...current.filter((item) => item.url !== cleanUrl)].slice(0, 4);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {
          // Playback still works when browser storage is unavailable or full.
        }
        return next;
      });
      requestAnimationFrame(() => {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        playerRef.current?.scrollIntoView({
          behavior: reducedMotion ? "auto" : "smooth",
          block: "start",
        });
      });
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
      setAuthState("gate");
    } catch {
      setError("退出失败，服务端会话可能仍然有效。请检查网络后再次点击退出。");
    } finally {
      setLoggingOut(false);
    }
  }

  function clearHistory() {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      // The in-memory list is still cleared when storage is unavailable.
    }
    setRecent([]);
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
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="粘贴 Jable、MissAV、M3U8 或 MP4 地址"
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
              源站适配为实验性功能，成功率取决于源站与服务器网络。
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
              <h2 id="player-heading">{result ? result.title : "等待一个视频链接"}</h2>
            </div>
            {result && (
              <span className="media-badge">
                {result.site === "direct" ? "媒体直链" : result.experimental ? "实验性源站适配" : result.site}
              </span>
            )}
          </div>

          {result ? (
            <VideoPlayer result={result} />
          ) : (
            <div className="empty-player" aria-live="polite">
              {resolving ? (
                <>
                  <div className="resolve-bars" aria-hidden="true"><i /><i /><i /><i /></div>
                  <p>正在连接源站并生成安全播放地址</p>
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
              <span>{hostOf(result.sourceUrl)}</span>
              <span><Clock3 size={14} />播放地址有效至 {formatTime(result.expiresAt)}</span>
            </div>
          )}
        </section>

        {recent.length > 0 && (
          <section className="recent-section" aria-labelledby="recent-heading">
            <div className="recent-heading-row">
              <div>
                <History size={18} />
                <h2 id="recent-heading">最近解析</h2>
              </div>
              <button className="text-button" type="button" onClick={clearHistory}>
                <Trash2 size={15} />清除
              </button>
            </div>
            <div className="recent-list">
              {recent.map((item) => (
                <button
                  className="recent-item"
                  type="button"
                  key={item.url}
                  disabled={resolving}
                  onClick={() => {
                    setUrl(item.url);
                    void resolveUrl(item.url);
                  }}
                >
                  <span className="recent-play"><Play size={16} fill="currentColor" /></span>
                  <span className="recent-copy">
                    <strong>{item.title}</strong>
                    <small>{hostOf(item.url)} · {formatTime(item.resolvedAt)}</small>
                  </span>
                  <ArrowRight size={18} />
                </button>
              ))}
            </div>
            <p className="local-note">记录仅保存在当前浏览器，清除浏览器数据后会消失。</p>
          </section>
        )}
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
