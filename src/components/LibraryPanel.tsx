import { useState } from "react";
import { ArrowRight, History, Play, Star, Trash2, X } from "lucide-react";
import type { LibraryItem, LibraryResponse } from "@contracts/types";

type LibraryPanelProps = {
  library: LibraryResponse;
  disabled: boolean;
  onPlay: (item: LibraryItem) => void;
  onRemove: (item: LibraryItem) => void;
  onClearHistory: () => void;
};

function sourceLabel(item: LibraryItem): string {
  if (item.site === "jable") return "Jable";
  if (item.site === "missav") return "MissAV";
  if (item.site === "torrent") return "BT";
  if (item.site === "pikpak") return "PikPak";
  try {
    return new URL(item.url).hostname.replace(/^www\./, "");
  } catch {
    return "媒体地址";
  }
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function progressOf(item: LibraryItem): number | null {
  if (!item.duration || !item.position) return null;
  return Math.min(1, item.position / item.duration);
}

export function LibraryPanel({
  library,
  disabled,
  onPlay,
  onRemove,
  onClearHistory,
}: LibraryPanelProps) {
  const [tab, setTab] = useState<"recent" | "favorites">("recent");
  const items = tab === "recent" ? library.recent : library.favorites;
  if (!library.recent.length && !library.favorites.length) return null;

  return (
    <section className="recent-section" aria-labelledby="recent-heading">
      <div className="recent-heading-row">
        <div className="library-tabs" role="tablist" aria-label="播放记录">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "recent"}
            className={tab === "recent" ? "is-active" : ""}
            onClick={() => setTab("recent")}
          >
            <History size={17} />
            <span id="recent-heading">最近播放</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "favorites"}
            className={tab === "favorites" ? "is-active" : ""}
            onClick={() => setTab("favorites")}
          >
            <Star size={17} />
            <span>收藏 {library.favorites.length || ""}</span>
          </button>
        </div>
        {tab === "recent" && library.recent.length > 0 && (
          <button className="text-button" type="button" onClick={onClearHistory}>
            <Trash2 size={15} />清除记录
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="local-note">还没有收藏。播放时点标题旁的星标即可收藏。</p>
      ) : (
        <div className="recent-list">
          {items.map((item) => {
            const progress = progressOf(item);
            return (
              <div className="recent-row" key={item.id}>
                <button
                  className="recent-item"
                  type="button"
                  disabled={disabled}
                  onClick={() => onPlay(item)}
                >
                  <span className="recent-play"><Play size={16} fill="currentColor" /></span>
                  <span className="recent-copy">
                    <strong>
                      {item.favorite && <Star size={13} fill="currentColor" className="recent-star" />}
                      {item.title}
                    </strong>
                    <small>{sourceLabel(item)} · {formatDate(item.lastPlayedAt)}</small>
                    {progress !== null && (
                      <span className="recent-progress" aria-label={`已看 ${Math.round(progress * 100)}%`}>
                        <i style={{ width: `${progress * 100}%` }} />
                      </span>
                    )}
                  </span>
                  <ArrowRight size={18} />
                </button>
                <button
                  className="icon-button recent-remove"
                  type="button"
                  onClick={() => onRemove(item)}
                  aria-label={`删除 ${item.title}`}
                  title="删除"
                >
                  <X size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="local-note">记录保存在服务器上，手机和电脑同步，并记住每个视频看到哪里。</p>
    </section>
  );
}
