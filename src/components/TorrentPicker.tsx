import { FileVideo, X } from "lucide-react";
import type { TorrentChoice } from "@contracts/types";

type TorrentPickerProps = {
  choice: TorrentChoice;
  onPick: (fileIndex: number) => void;
  onCancel: () => void;
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function TorrentPicker({ choice, onPick, onCancel }: TorrentPickerProps) {
  return (
    <div className="torrent-picker">
      <div className="torrent-picker-heading">
        <div>
          <p className="utility-label">
            {choice.source === "pikpak" ? "PikPak" : "BT"} · 选择要播放的文件
          </p>
          <h3>{choice.title}</h3>
        </div>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="取消" title="取消">
          <X size={18} />
        </button>
      </div>
      <div className="torrent-files">
        {choice.files.map((file) => (
          <button key={file.index} type="button" className="torrent-file" onClick={() => onPick(file.index)}>
            <FileVideo size={18} aria-hidden="true" />
            <span>{file.name.split("/").pop()}</span>
            <small>{formatSize(file.length)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
