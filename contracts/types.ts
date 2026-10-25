export * from "./errors";

export type MediaSite = "jable" | "missav" | "direct" | "torrent" | "pikpak";
/** hls: an HLS playlist (incl. ones remuxed on the server); file: a single progressive file. */
export type MediaKind = "hls" | "file";

export type ResolveRequest = {
  url: string;
  /** Torrent only: which file to play, from a previous TorrentChoice. */
  fileIndex?: number;
};

export type ResolveMediaResult = {
  title: string;
  sourceUrl: string;
  site: MediaSite;
  kind: MediaKind;
  streamUrl: string;
  posterUrl: string | null;
  expiresAt: number;
  experimental: boolean;
  /** The server is still converting the file: seeking past the converted part waits. */
  converting?: boolean;
  fileIndex?: number;
  /** Key of this item in the synced library (history, favorites, progress). */
  libraryId: string;
  /** Saved playback position in seconds, if the video was watched before. */
  resumeAt: number | null;
  favorite: boolean;
};

export type TorrentFile = {
  index: number;
  name: string;
  length: number;
};

/** A torrent with several videos: the user picks one, then resolves again with fileIndex. */
export type TorrentChoice = {
  needsFileChoice: true;
  /** Where the files come from; a torrent when absent. */
  source?: "torrent" | "pikpak";
  title: string;
  sourceUrl: string;
  files: TorrentFile[];
};

/** A magnet is still looking for peers; the client asks again shortly. */
export type TorrentPending = {
  pending: true;
  peers: number;
};

export type ResolveResponse = ResolveMediaResult | TorrentChoice | TorrentPending;

export type LibraryItem = {
  id: string;
  url: string;
  fileIndex: number | null;
  title: string;
  site: MediaSite;
  favorite: boolean;
  position: number;
  duration: number;
  lastPlayedAt: number;
};

export type LibraryResponse = {
  recent: LibraryItem[];
  favorites: LibraryItem[];
};

export type AccessStatus = {
  authenticated: boolean;
};
