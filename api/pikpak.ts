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
import {
  accountFromEnv,
  ensureMyFolder,
  fileLink,
  listMyFolder,
  listShareFolder,
  openShare,
  PikPakApiError,
  restoreShareFiles,
  type ShareEntry,
} from "./pikpakApi";
import { RouteError } from "./routeUtils";

// PikPak share links (mypikpak.com/s/<id>).
// - With a PikPak account in .env, the chosen file is saved ("转存") into the
//   drive folder 流光转存 and played from there, in full.
// - Without an account, the share is mounted anonymously in OpenList; PikPak
//   then usually only hands out a preview link.

export const SAVE_FOLDER = "流光转存";

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

async function resolveAnonymously(
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

// ── with an account: save into the drive, then play ────────────────────────

type SharedVideo = { id: string; path: string; name: string; size: number };

async function shareVideos(shareId: string, passCodeToken: string, top: ShareEntry[]): Promise<SharedVideo[]> {
  const videos: SharedVideo[] = [];
  const queue: { entries: ShareEntry[]; prefix: string; depth: number }[] = [
    { entries: top, prefix: "", depth: 0 },
  ];
  let calls = 0;
  while (queue.length && videos.length < MAX_FILES) {
    const { entries, prefix, depth } = queue.shift()!;
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDir) {
        if (depth < 4 && calls < MAX_LIST_CALLS) {
          calls += 1;
          queue.push({ entries: await listShareFolder(shareId, passCodeToken, entry.id), prefix: path, depth: depth + 1 });
        }
      } else if (VIDEO_NAME.test(entry.name)) {
        videos.push({ id: entry.id, path, name: entry.name, size: entry.size });
      }
    }
  }
  return videos.sort((a, b) => a.path.localeCompare(b.path));
}

let saveFolderId: string | null = null;

/** The file's copy in the user's drive, saving it from the share if needed. */
async function savedCopy(shareId: string, passCodeToken: string, video: SharedVideo): Promise<string> {
  saveFolderId ??= await ensureMyFolder(SAVE_FOLDER);
  const folderId = saveFolderId;
  const find = async (parentId: string) =>
    (await listMyFolder(parentId)).find(
      (file) => !file.isDir && file.name === video.name && (!video.size || file.size === video.size),
    );
  const existing = await find(folderId);
  if (existing) return existing.id;

  await restoreShareFiles(shareId, passCodeToken, [video.id], folderId);
  // Saving is usually instant; give PikPak a few seconds before giving up.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 500 : 1500));
    const saved = (await find(folderId)) || (await find(""));
    if (saved) return saved.id;
  }
  throw new RouteError(504, "已经提交转存，但网盘里暂时还没有这个文件，请稍后重试。", "PIKPAK_SAVE_PENDING");
}

async function resolveWithAccount(
  share: PikPakShare,
  sourceUrl: string,
  fileIndex: number | undefined,
): Promise<ResolvedStream | TorrentChoice> {
  const opened = await openShare(share.shareId, share.password);
  const videos = await shareVideos(share.shareId, opened.passCodeToken, opened.files);
  if (!videos.length) {
    throw new RouteError(400, "这个 PikPak 分享里没有可播放的视频文件。", "NO_VIDEO_IN_SHARE");
  }
  const chosenIndex = fileIndex ?? (videos.length === 1 ? 0 : undefined);
  if (chosenIndex === undefined) {
    return {
      needsFileChoice: true,
      source: "pikpak",
      title: "PikPak 分享（选择后自动转存到网盘）",
      sourceUrl,
      files: videos
        .map((video, index) => ({ index, name: video.path, length: video.size }))
        .sort((a, b) => b.length - a.length),
    };
  }
  const video = videos[chosenIndex];
  if (!video) throw new RouteError(400, "分享里没有这个文件，可能已被修改。", "BAD_FILE_INDEX");

  const ownId = await savedCopy(share.shareId, opened.passCodeToken, video);
  const link = await fileLink(ownId);
  if (!link.url) throw new RouteError(502, "PikPak 没有返回播放地址。", "PIKPAK_NO_LINK");
  return streamFromUrl(new URL(link.url), {
    title: baseName(video.name),
    sourceUrl,
    site: "pikpak",
    fileIndex: chosenIndex,
    fileName: video.name,
    // Download links expire and change; the saved file does not.
    key: `pikpak-own:${ownId}`,
  });
}

export async function resolvePikPakShare(
  share: PikPakShare,
  sourceUrl: string,
  fileIndex: number | undefined,
): Promise<ResolvedStream | TorrentChoice> {
  if (!accountFromEnv()) return resolveAnonymously(share, sourceUrl, fileIndex);
  try {
    return await resolveWithAccount(share, sourceUrl, fileIndex);
  } catch (error) {
    // The save folder may have been deleted or renamed in the app meanwhile.
    saveFolderId = null;
    if (error instanceof PikPakApiError) {
      throw new RouteError(502, `PikPak：${error.message}`, "PIKPAK_API_FAILED");
    }
    throw error;
  }
}
