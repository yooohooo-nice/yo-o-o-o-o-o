// Run with: npm test (needs ffmpeg/ffprobe on PATH).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "liuguang-media-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.INTERNAL_SECRET = "test-secret";
process.env.TORRENT_PORT = "0";
fs.mkdirSync(path.join(tmp, "data/remux"), { recursive: true });
fs.mkdirSync(path.join(tmp, "data/torrents"), { recursive: true });

const { createServer, shutdown } = await import("../server.mjs");
const { default: WebTorrent } = await import("webtorrent");

function ffmpeg(...args) {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args]);
}
const sample = path.join(tmp, "movie.mkv");
const xvid = path.join(tmp, "old.avi");
ffmpeg("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=330",
  "-t", "14", "-c:v", "libx264", "-g", "50", "-pix_fmt", "yuv420p", "-c:a", "ac3", sample);
ffmpeg("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "2", "-c:v", "mpeg4", xvid);

let worker;
let files;
let base;
let seeder;
before(async () => {
  worker = createServer().listen(0);
  files = http.createServer((req, res) => fs.createReadStream(path.join(tmp, req.url.slice(1))).pipe(res)).listen(0);
  await Promise.all([worker, files].map((s) => new Promise((r) => s.once("listening", r))));
  base = `http://127.0.0.1:${worker.address().port}`;
});
after(async () => {
  await shutdown();
  seeder?.destroy();
  worker.close();
  files.close();
});

const auth = { "x-internal-secret": "test-secret", "content-type": "application/json" };
const post = (p, body) => fetch(base + p, { method: "POST", headers: auth, body: JSON.stringify(body) });
const fileUrl = (name) => `http://127.0.0.1:${files.address().port}/${name}`;

async function playlistUntil(id, predicate) {
  for (let i = 0; i < 60; i += 1) {
    const res = await fetch(`${base}/remux/${id}/index.m3u8`, { headers: auth });
    const text = await res.text();
    if (res.ok && predicate(text)) return text;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("playlist never matched");
}

test("rejects requests without the internal secret", async () => {
  const res = await fetch(`${base}/remux`, { method: "POST", body: "{}" });
  assert.equal(res.status, 403);
});

test("remuxes MKV with AC3 audio to HLS without re-encoding video", async () => {
  const res = await post("/remux", { key: "movie", input: fileUrl("movie.mkv") });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const playlist = await playlistUntil(id, (t) => t.includes("#EXT-X-ENDLIST"));
  assert.match(playlist, /#EXT-X-MAP:URI="init.mp4"/);
  assert.match(playlist, /seg00000\.m4s/);
  const init = await fetch(`${base}/remux/${id}/init.mp4`, { headers: auth });
  assert.equal(init.status, 200);
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name",
    "-of", "csv=p=0", path.join(process.env.DATA_DIR, "remux", id, "index.m3u8")]).toString();
  assert.match(probe, /h264/);
  assert.match(probe, /aac/);
  // The same source maps to the same job instead of starting again.
  const again = await (await post("/remux", { key: "movie", input: fileUrl("movie.mkv") })).json();
  assert.equal(again.id, id);
});

test("refuses codecs that would need re-encoding", async () => {
  const res = await post("/remux", { key: "xvid", input: fileUrl("old.avi") });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "UNSUPPORTED_CODEC");
});

test("streams a torrent with byte ranges and remuxes it", async () => {
  seeder = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false, torrentPort: 0 });
  const seedDir = path.join(tmp, "seed");
  fs.mkdirSync(seedDir);
  fs.copyFileSync(sample, path.join(seedDir, "movie.mkv"));
  fs.writeFileSync(path.join(seedDir, "readme.txt"), "hello");
  const seeded = await new Promise((r) => seeder.seed(seedDir, { announce: [] }, r));
  await new Promise((r) => (seeder.listening ? r() : seeder.once("listening", r)));
  const magnet = `${seeded.magnetURI}&x.pe=127.0.0.1:${seeder.address().port}`;

  const res = await post("/torrent", { magnet });
  assert.equal(res.status, 200);
  const info = await res.json();
  const movie = info.files.find((f) => f.name.endsWith("movie.mkv"));
  assert.equal(movie.kind, "remux");
  assert.equal(info.files.find((f) => f.name.endsWith("readme.txt")).kind, null);

  const ranged = await fetch(`${base}/torrent/${info.infoHash}/${movie.index}`, {
    headers: { ...auth, range: "bytes=1000-1999" },
  });
  assert.equal(ranged.status, 206);
  const bytes = Buffer.from(await ranged.arrayBuffer());
  assert.ok(bytes.equals(fs.readFileSync(sample).subarray(1000, 2000)));

  const job = await (await post("/remux-torrent", { infoHash: info.infoHash, index: movie.index })).json();
  await playlistUntil(job.id, (t) => t.includes("#EXT-X-ENDLIST"));
});
