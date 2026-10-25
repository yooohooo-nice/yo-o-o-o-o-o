import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronLeft,
  FileVideo,
  Folder,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { PikPakEntry, PikPakStatus } from "@contracts/types";

const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|flv|ts|m2ts|mts|wmv|mpg|mpeg|rmvb|rm|3gp)$/i;

type PikPakPanelProps = {
  onPlay: (path: string) => void;
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function parentOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}`;
}

export function PikPakPanel({ onPlay }: PikPakPanelProps) {
  const [status, setStatus] = useState<PikPakStatus | null>(null);
  const [path, setPath] = useState("/");
  const [items, setItems] = useState<PikPakEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async (dir: string, refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch<{ items: PikPakEntry[] }>(
        `/api/pikpak/list?path=${encodeURIComponent(dir)}${refresh ? "&refresh=1" : ""}`,
      );
      setItems(data.items);
      setPath(dir);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取网盘失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await apiFetch<PikPakStatus>("/api/pikpak/status");
        if (cancelled) return;
        setStatus(current);
        if (current.ready) {
          void load("/");
        }
      } catch (reason) {
        if (!cancelled) setStatus({ configured: true, ready: false, error: (reason as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (!status) {
    return (
      <div className="empty-player">
        <LoaderCircle className="spin" size={28} />
        <p>正在连接 PikPak</p>
      </div>
    );
  }
  if (!status.ready) {
    return (
      <div className="pikpak-setup">
        <AlertCircle size={22} />
        <div>
          <h3>{status.configured ? "PikPak 暂时连不上" : "还没有设置 PikPak 账号"}</h3>
          <p>
            {status.error ||
              "在服务器上编辑 ~/liuguang/.env，加入 PIKPAK_USERNAME=你的账号 和 PIKPAK_PASSWORD=你的密码，然后运行 docker compose up -d。"}
          </p>
        </div>
      </div>
    );
  }

  const crumbs = path.split("/").filter(Boolean);

  return (
    <div className="pikpak-panel">
      <div className="pikpak-toolbar">
        <div className="pikpak-crumbs">
          <button type="button" className="text-button" onClick={() => void load("/")}>我的 PikPak</button>
          {crumbs.map((part, index) => (
            <span key={index}>
              <span aria-hidden="true">/</span>
              <button
                type="button"
                className="text-button"
                onClick={() => void load(`/${crumbs.slice(0, index + 1).join("/")}`)}
              >
                {part}
              </button>
            </span>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => void load(path, true)}
          aria-label="刷新"
          title="刷新"
          disabled={loading}
        >
          <RefreshCw size={17} className={loading ? "spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="resolve-error" role="alert">
          <AlertCircle size={18} />
          <p>{error}</p>
        </div>
      )}

      <div className="torrent-files">
        {path !== "/" && (
          <button type="button" className="torrent-file" onClick={() => void load(parentOf(path))}>
            <ChevronLeft size={18} aria-hidden="true" />
            <span>上一级</span>
            <small />
          </button>
        )}
        {items.map((item) =>
          item.isDir ? (
            <button key={item.path} type="button" className="torrent-file" onClick={() => void load(item.path)}>
              <Folder size={18} aria-hidden="true" />
              <span>{item.name}</span>
              <small />
            </button>
          ) : (
            <button
              key={item.path}
              type="button"
              className={`torrent-file ${VIDEO.test(item.name) ? "" : "is-muted"}`}
              onClick={() => VIDEO.test(item.name) && onPlay(item.path)}
              disabled={!VIDEO.test(item.name)}
            >
              <FileVideo size={18} aria-hidden="true" />
              <span>{item.name}</span>
              <small>{formatSize(item.size)}</small>
            </button>
          ),
        )}
        {!loading && !items.length && <p className="local-note">这个文件夹是空的。</p>}
      </div>
    </div>
  );
}
