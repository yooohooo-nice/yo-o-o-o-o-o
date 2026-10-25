# 流光播放器

一个手机优先、密码保护的网页播放器。粘贴视频页、媒体直链或磁力链接后，由服务端实时解析并通过同源代理播放。

## 功能

- **播放器**（ArtPlayer）：拖动进度条显示时间；手机上左右滑动快进快退并显示 `12:34 / 45:00`；长按 3 倍速；双击左右两侧快退／快进 10 秒、双击中间暂停；倍速、画面比例、画中画、AirPlay、锁屏；电脑快捷键（空格、方向键）。iPhone 点全屏进入系统原生播放器。
- **播放记录同步**：最近播放、收藏和每个视频的播放进度保存在服务器，手机和电脑之间同步，重新打开自动从上次位置继续。
- **从分享菜单打开**：安卓可在任意 App 的分享菜单直接选“流光”；iPhone 通过“快捷指令”实现（见下文）。也可以直接打开 `https://你的域名/?url=视频地址`。
- 共享密码访问与 18 岁确认；HttpOnly 会话 Cookie；连续 5 次密码错误锁定 15 分钟；各接口限流。
- 可以添加到手机主屏幕，像 App 一样全屏打开（PWA）。
- 内置 Mux 公开测试流“播放自检”。

## 支持的链接

| 链接 | 怎么播放 |
|---|---|
| Jable、MissAV 视频页 | 解析出 HLS 后代理播放（经 fetcher 绕过 Cloudflare） |
| `.m3u8` | HLS，播放列表、分片、密钥由服务端重写并代理 |
| `.mp4` `.m4v` `.mov` `.webm` | 浏览器直接播放，支持拖动 |
| `.mkv` `.flv` `.avi` `.ts` `.wmv` `.mpg` 等 | media 服务用 ffmpeg 转封装为 HLS（视频不重新压缩，只转音频），边转边播 |
| 没有扩展名的直链 | 先读取文件开头自动识别格式 |
| PikPak 分享 `mypikpak.com/s/…` | 经内置的 OpenList 读取分享（不需要 PikPak 账号）；多个视频时先选择文件；有提取码在链接后加 `?pwd=提取码` |
| 磁力链接 `magnet:?xt=urn:btih:…` | BT 边下边播；多个视频时先选择文件 |
| `.torrent` 种子地址 | 同上 |

限制：
- 转封装要求视频编码是 H.264 或 H.265（绝大多数文件都是）。老式 XviD／DivX、RMVB 等需要重新压缩，2 核服务器无法实时处理，会直接提示。H.265 在 iPhone 和大部分新电脑上能播，个别安卓／旧电脑不行。
- 转封装期间往后拖动，需要等待已转换到那里；转换速度取决于源站速度，一般比播放快很多。
- BT 速度取决于有多少人在分享；没人分享的资源会提示“找不到下载源”。

## 使用须知

- 仅限成年人使用。访问者须拥有所看内容的合法观看权限，并遵守源站条款与当地法律。
- **BT 的特殊风险**：BT 协议在下载的同时一定会上传给其他人，你的服务器 IP 会出现在下载者列表里。下载受版权保护的内容在很多地区违法，不少 VPS 服务商也禁止 BT，收到版权投诉可能被封机。上传速度默认限制为 200 KB/s；不需要 BT 时可在 `.env` 设置 `BT_ENABLED=false`。
- BT 和转封装的临时数据存放在服务器上，默认最多 8 GB（`MEDIA_MAX_GB`），超出或一段时间没人看会自动删除。
- Jable／MissAV 适配可能受到反爬、页面结构变化和服务器网络影响。
- 媒体地址防护包括协议、端口、公网 IP 和重定向检查，但不应被视为能够消除所有 DNS 或上游风险的绝对保证。

## 部署（个人自用）

服务器只需要装好 Docker（含 docker compose 插件）。数据库表在程序启动时自动创建，无需手动执行 `db:push`。

```bash
git clone https://github.com/yooohooo-nice/yo-o-o-o-o-o.git liuguang && cd liuguang
cp .env.example .env
# 编辑 .env：填写 ACCESS_PASSWORD、APP_SECRET、DB_PASSWORD（生成随机串：openssl rand -hex 32）
```

### 方案 A：公网服务器 + 域名（Caddy 自动 HTTPS）

1. 把域名（如 `play.example.com`）的 A 记录解析到服务器 IP，并在 `.env` 里设置 `DOMAIN=play.example.com`。
2. 服务器防火墙 / 安全组放行 80、443 端口。
3. 确认 `.env` 里 `COMPOSE_PROFILES` 包含 `caddy`，然后启动：

```bash
docker compose up -d --build
```

浏览器打开 `https://你的域名` 即可。

### 方案 B：家里电脑 / NAS + Tailscale（不暴露公网，推荐）

1. 在这台机器和手机上都安装 [Tailscale](https://tailscale.com/download) 并登录同一账号。
2. 在 Tailscale 管理后台的 DNS 页面开启 MagicDNS 和 HTTPS Certificates。
3. 把 `.env` 里的 `COMPOSE_PROFILES` 改成不含 `caddy`（例如只写 `flaresolverr`，或留空），然后启动并开启 HTTPS 转发：

```bash
docker compose up -d --build
sudo tailscale serve --bg 3000
```

`tailscale serve status` 会显示访问地址（形如 `https://机器名.xxx.ts.net`），只有你自己 Tailscale 网络里的设备能打开。

### 绕过 Cloudflare

Jable、MissAV 都在 Cloudflare 后面，Node 自带的请求很容易被识别并拦截。所以所有对源站的请求都经过 `fetcher/` 服务：

1. **curl_cffi 浏览器伪装**（默认开启）：用 Chrome 的 TLS / HTTP2 指纹发请求，和原版 FetchJAV 的做法一样，大多数情况下就够了。
2. **FlareSolverr**（可选，`COMPOSE_PROFILES` 里加上 `flaresolverr`）：如果仍然遇到“Just a moment”验证页，就用无头 Chrome 真正打开一次页面，通过验证后把 `cf_clearance` Cookie 保存 2 小时，之后的请求直接复用。需要多约 500MB 内存。

查看是否触发了验证：`docker compose logs fetcher | grep challenge`。如果出现 `flaresolverr solved challenge` 说明已自动通过。

### PikPak 分享（OpenList）

`docker compose` 会一起启动 [OpenList](https://github.com/OpenListTeam/OpenList)（`openlist` 服务，约占 60 MB 内存），只在内部网络可见。粘贴 PikPak 分享链接时，app 会自动把这个分享挂载进 OpenList，列出里面的视频，再取下载地址交给播放器；MKV 等格式同样自动转换。OpenList 的管理员密码就是 `.env` 里的 `APP_SECRET`，不需要单独设置，也不需要打开它的网页。

- 播放分享不需要 PikPak 账号。
- 下载地址由 PikPak 生成，几个小时后失效；从“最近播放”重新打开会自动获取新地址。
- 查看日志：`docker compose logs --tail 30 openlist`

### iPhone 分享菜单打开（快捷指令）

iPhone 的网页 App 不能直接出现在分享菜单里，用系统自带的“快捷指令”App 做一个，只需设置一次：

1. 打开“快捷指令” App → 右上角 `+` 新建。
2. 点顶部名称改成“用流光播放”。点底部 ⓘ → 打开“在共享表单中显示”，接收类型只勾“URL”和“文本”。
3. 添加操作“URL 编码”，输入选“快捷指令输入”。
4. 添加操作“文本”，内容填 `https://你的域名/?url=`，然后在后面插入变量“URL 编码后的文本”。
5. 添加操作“打开 URL”，输入选上一步的“文本”。完成。

之后在 Safari、微信或其他 App 里点分享 → “用流光播放”，就会在 Safari 里打开并自动解析播放。磁力链接也可以先复制，再在快捷指令 App 里运行（把第 3 步输入改成“剪贴板”可以单独做一个“播放剪贴板”的快捷指令）。

### 添加到手机主屏幕（PWA）

- **iPhone / iPad**：用 Safari 打开网址 → 点底部分享按钮 → “添加到主屏幕”。注意：主屏幕上的 App 和 Safari 的登录状态是分开的，第一次打开需要再输入一次密码。
- **安卓**：用 Chrome 打开，页面顶部会出现“安装”按钮；或者在 Chrome 菜单里选“添加到主屏幕 / 安装应用”。

### 更新到新版本

```bash
cd ~/liuguang && git pull && docker compose up -d --build
```

数据库表会在启动时自动升级，原来的设置和记录都会保留。

### 常用命令

```bash
docker compose logs -f app       # 查看日志（换成 media 看 BT 和转换，fetcher 看源站访问）
git pull && docker compose up -d --build   # 更新版本
docker compose down              # 停止（数据保留）
```

> 必须通过 HTTPS 访问才能登录：生产模式下登录 Cookie 带 `Secure` 标记，浏览器在 `http://` 下会丢弃它，表现为“密码正确但一直回到登录页”。只在内网 / VPN 内用纯 http 时，才可在 `.env` 设置 `COOKIE_SECURE=false`。

## 本地开发

要求 Node.js 20+，以及一个 MySQL / MariaDB 数据库。

```bash
npm install
cp .env.example .env
# 填写 ACCESS_PASSWORD、APP_SECRET，并取消注释、填写 DATABASE_URL
npm run db:migrate
npm run dev
```

开发服务运行于 `http://localhost:3000`。修改 `db/schema.ts` 后用 `npm run db:generate` 生成新的迁移文件并提交。

### 环境变量

完整说明见 `.env.example`。生产环境必须设置 `ACCESS_PASSWORD` 和 `APP_SECRET`，不要把真实的 `.env` 提交到版本库。

## 验证与构建

```bash
npm run check       # TypeScript 类型检查
npm run test        # 访问控制与真实公开测试流集成测试
(cd fetcher && pip install -r requirements.txt && python -m unittest test_app)  # 抓取服务测试
(cd media && npm ci && npm test)  # 媒体服务测试（需要本机有 ffmpeg）
npm run build       # 构建前端和自包含服务端 bundle
npm start           # 生产模式启动
```

生产构建入口为 `dist/boot.js`，前端静态文件位于 `dist/public/`。服务端依赖已打包进 `dist/boot.js`，运行构建产物不需要复制 `node_modules`。

## 主要接口

- `GET /api/access/status`
- `POST /api/access/login`
- `POST /api/access/logout`
- `POST /api/media/resolve`（`{ url, fileIndex? }`，种子有多个视频时返回文件列表）
- `GET|HEAD /api/media/stream`
- `GET|HEAD /api/media/remux/:id/:file`（转封装后的 HLS）
- `GET|HEAD /api/media/torrent/:infoHash/:index`（BT 文件，支持 Range）
- `GET /api/media/poster`
- `GET /api/library`、`POST /api/library/progress`、`POST /api/library/favorite`、`DELETE /api/library/:id`、`DELETE /api/library/history`
- `GET|HEAD /internal/source`（仅供 media 服务使用，需要内部密钥）

媒体与记录接口均要求有效访问会话。播放地址为短期签名地址，不是可任意指定目标的开放代理。

## 来源与许可证

解析思路参考 FetchJAV（Apache-2.0）。字体、播放引擎、测试流和其他来源见 [CREDITS.md](./CREDITS.md)；相关许可证文本位于 `licenses/`。
