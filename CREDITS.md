# 来源与许可

## FetchJAV

- 项目：https://github.com/FetchJAV/FetchJAV_Public
- 用途：研究 Jable／MissAV 页面解析、MissAV packed JavaScript 解码、媒体请求头与 HLS 代理思路。
- 许可证：Apache License 2.0。
- 本项目是独立的网页实现，不是原 Windows 程序的直接移植。
- 许可证副本：`licenses/FetchJAV-LICENSE.txt`。

## Satoshi

- 字体：Satoshi，Indian Type Foundry / Fontshare。
- 字体页面：https://www.fontshare.com/fonts/satoshi
- 用途：界面拉丁文字与数字；中文使用系统字体回退。
- 许可：ITF Free Font License，允许在遵守条款的情况下用于个人或商业项目并在自有网站自托管。
- 许可全文：https://www.fontshare.com/licenses/itf-ffl
- 字体文件未经修改，位于 `public/fonts/`。

## Hls.js

- 项目：https://github.com/video-dev/hls.js
- 用途：在不支持原生 HLS 的浏览器中播放 HLS。
- 许可证：Apache License 2.0。
- 许可证副本：`licenses/HlsJS-LICENSE.txt`。

## Cheerio

- 项目：https://github.com/cheeriojs/cheerio
- 用途：服务端解析视频页 HTML 与 meta 信息。
- 许可证：MIT。
- 许可证副本：`licenses/Cheerio-LICENSE.txt`。

## ipaddr.js

- 项目：https://github.com/whitequark/ipaddr.js
- 用途：辅助检查媒体目标 IP 类型。
- 许可证：MIT。
- 许可证副本：`licenses/ipaddrjs-LICENSE.txt`。

## curl_cffi

- 项目：https://github.com/lexiforest/curl_cffi
- 用途：`fetcher/` 服务以 Chrome 的 TLS／HTTP2 指纹请求源站。
- 许可证：MIT。

## FlareSolverr（可选，独立 Docker 镜像）

- 项目：https://github.com/FlareSolverr/FlareSolverr
- 用途：遇到 Cloudflare 验证页时，用无头 Chrome 通过验证。未修改、未打包进本项目，按需从官方镜像拉取。
- 许可证：MIT。

## ArtPlayer

- 项目：https://github.com/zhw2590582/ArtPlayer
- 用途：网页播放器界面、手势与控制。
- 许可证：MIT。

## WebTorrent

- 项目：https://github.com/webtorrent/webtorrent
- 用途：`media/` 服务中磁力链接与种子的边下边播。
- 许可证：MIT。

## OpenList

- 项目：https://github.com/OpenListTeam/OpenList
- 用途：作为独立的 Docker 服务读取 PikPak 分享（PikPakShare 驱动）。以官方镜像运行，未修改、未与本项目代码链接，仅通过 HTTP API 调用。
- 许可证：AGPL-3.0。

## FFmpeg

- 项目：https://ffmpeg.org
- 用途：`media/` 服务把 MKV、FLV 等转封装为 HLS。作为独立程序从 Debian 官方软件源安装并调用，未修改、未与本项目代码链接。
- 许可证：LGPL／GPL（以 Debian 打包版本为准）。

## Mux 公开测试流

- 主测试流：https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
- 自检低带宽列表：https://test-streams.mux.dev/x36xhzz/url_2/193039199_mp4_h264_aac_ld_7.m3u8
- 用途：播放自检与自动化集成测试，不作为成人源站内容。
- 仅用于技术验证；相关内容的权利归其原权利人所有。

## 其他基础组件

React、Vite、Hono、tRPC、Drizzle ORM、MySQL、Lucide 和其他 npm 依赖的许可证信息随各自软件包提供。完整依赖及版本以 `package.json` 与 `package-lock.json` 为准。
