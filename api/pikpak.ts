import type { TorrentChoice } from "@contracts/types";
import { baseName, streamFromUrl, VIDEO_NAME, type ResolvedStream } from "./media";
import {
  createStorage,
  deleteStorage,
  errorMessage,
  findStorage,
  listDir,
  rawUrl,
} from "./openlist";
import { RouteError } from "./routeUtils";

// PikPak share links (mypikpak.com/s/<id>) are opened through OpenList.
// Each share is mounted as an OpenList "PikPakShare" storage; no PikPak
// account is needed to list a share. Note that PikPak may only hand out a
// preview link for files that have not been saved to one's own drive; the
// "My PikPak" page (pikpakDrive.ts) plays saved files in full.

const SHARE_HOSTS = /(^|\.)mypikpak\.(com|net)$|(^|\.)pikpak\.me$/i;
const SHARE_ROOT = "/pikpak-share";
const MAX_LIST_CALLS = 40;
const MAX_FILES = 500;

export type PikPakShare = { shareId: string; password: string };

export function parsePikPakShare(input: URL): PikPakShare | null {
  if (!SHARE_HOSTS.test(input.hostname)) return null;
  const match = input.pathname.match(/^\/s\/([A-Za-z0-9_-]{8,64})/);
  if (!match) return null;
  const password = input.searchParams.get("pwd") || input.searchParams.get("password") || "";
  return { shareId: match[1], password: password.slice(0, 64) };
}

async function mountShare(share: PikPakShare): Promise<string> {
  const mountPath = `${SHARE_ROOT}/${share.shareId}`;
  const existing = await findStorage(mountPath);
  if (existing) {
    let samePassword = false;
    try {
      samePassword = JSON.parse(existing.addition).share_pwd === share.password;
    } catch {
      // Unreadable settings: remount below.
    }
    if (existing.status === "work" && samePassword) return mountPath;
    await deleteStorage(existing.id);
  }
  try {
    await createStorage({
      mountPath,
      driver: "PikPakShare",
      remark: "流光自动添加的 PikPak 分享",
      addition: {
        root_folder_id: "",
        share_id: share.shareId,
        share_pwd: share.password,
        platform: "web",
        device_id: "",
        use_transcoding_address: false,
      },
    });
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(
      400,
      `PikPak 分享打不开（${errorMessage(error).slice(0, 120)}）。请检查链接是否失效；有提取码的请在链接后加上 ?pwd=提取码。`,
      "PIKPAK_SHARE_FAILED",
    );
  }
  return mountPath;
}

type ShareFile = { path: string; name: string; size: number };

/** Every video in the share, breadth-first, in a stable order. */
async function listVideos(mountPath: string): Promise<ShareFile[]> {
  const files: ShareFile[] = [];
  const queue = [{ path: mountPath, depth: 0 }];
  let calls = 0;
  while (queue.length && calls < MAX_LIST_CALLS && files.length < MAX_FILES) {
    const { path, depth } = queue.shift()!;
    calls += 1;
    for (const item of await listDir(path)) {
      const itemPath = `${path}/${item.name}`;
      if (item.is_dir) {
        if (depth < 4) queue.push({ path: itemPath, depth: depth + 1 });
      } else if (VIDEO_NAME.test(item.name)) {
        files.push({ path: itemPath, name: itemPath.slice(mountPath.length + 1), size: item.size });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function resolvePikPakShare(
  share: PikPakShare,
  sourceUrl: string,
  fileIndex: number | undefined,
): Promise<ResolvedStream | TorrentChoice> {
  let mountPath: string;
  let files: ShareFile[];
  try {
    mountPath = await mountShare(share);
    files = await listVideos(mountPath);
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(502, `读取 PikPak 分享失败：${errorMessage(error).slice(0, 120)}`, "PIKPAK_LIST_FAILED");
  }
  if (!files.length) {
    throw new RouteError(400, "这个 PikPak 分享里没有可播放的视频文件。", "NO_VIDEO_IN_SHARE");
  }
  const chosenIndex = fileIndex ?? (files.length === 1 ? 0 : undefined);
  if (chosenIndex === undefined) {
    return {
      needsFileChoice: true,
      source: "pikpak",
      title: "PikPak 分享",
      sourceUrl,
      files: files
        .map((file, index) => ({ index, name: file.name, length: file.size }))
        .sort((a, b) => b.length - a.length),
    };
  }
  const file = files[chosenIndex];
  if (!file) throw new RouteError(400, "分享里没有这个文件，可能已被修改。", "BAD_FILE_INDEX");

  let link: string;
  try {
    link = (await rawUrl(file.path)).rawUrl;
  } catch (error) {
    if (error instanceof RouteError) throw error;
    throw new RouteError(502, `获取播放地址失败：${errorMessage(error).slice(0, 120)}`, "PIKPAK_LINK_FAILED");
  }
  if (!link) throw new RouteError(502, "PikPak 没有返回播放地址。", "PIKPAK_NO_LINK");

  return streamFromUrl(new URL(link), {
    title: baseName(file.name),
    sourceUrl,
    site: "pikpak",
    fileIndex: chosenIndex,
    fileName: file.name,
    // Download links expire and change; the file itself does not.
    key: `pikpak:${share.shareId}:${file.path}`,
  });
}
