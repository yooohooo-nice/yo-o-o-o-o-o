# 流光播放器

一个手机优先、密码保护的网页播放器。粘贴视频页或媒体直链后，由服务端实时解析并通过同源代理播放；服务器不保存视频文件，也不提供公共下载。

## 第一版功能

- 共享密码访问与 18 岁确认。
- HttpOnly 会话 Cookie；数据库仅保存会话令牌哈希。
- 连续 5 次密码错误后锁定 15 分钟；解析、播放和封面接口分别限流。
- 支持 `.m3u8` 与 `.mp4` 公网直链。
- 实验性支持 Jable、MissAV 单个视频页及已配置的镜像。
- HLS 播放列表、分片、密钥与 MAP 地址由服务端重新签名并代理。
- Chrome、Edge 等浏览器使用 Hls.js；Safari 使用原生 HLS。
- 内置 Mux 公开测试流“播放自检”，用于独立验证密码、解析、代理和播放器链路。
- 最近解析记录只保存在当前浏览器的 `localStorage`，不上传为服务端历史记录。

## 使用限制

- 仅限成年人使用。访问者须拥有所看内容的合法观看权限，并遵守源站条款与当地法律。
- Jable／MissAV 适配为实验性功能，可能受到反爬、页面结构变化、地区限制和服务器网络影响。
- 当前开发网络未能完成 Jable／MissAV 在线实测；公开 Mux 测试流的解析、列表重写和分片代理已通过自动化测试。
- 不包含原 Windows 项目的本地下载、AI 字幕、OCR、Whisper 或离线翻译功能。
- 可以添加到手机主屏幕，像 App 一样全屏打开（PWA）。
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

### 添加到手机主屏幕（PWA）

- **iPhone / iPad**：用 Safari 打开网址 → 点底部分享按钮 → “添加到主屏幕”。注意：主屏幕上的 App 和 Safari 的登录状态是分开的，第一次打开需要再输入一次密码。
- **安卓**：用 Chrome 打开，页面顶部会出现“安装”按钮；或者在 Chrome 菜单里选“添加到主屏幕 / 安装应用”。

### 常用命令

```bash
docker compose logs -f app       # 查看日志
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
npm run build       # 构建前端和自包含服务端 bundle
npm start           # 生产模式启动
```

生产构建入口为 `dist/boot.js`，前端静态文件位于 `dist/public/`。服务端依赖已打包进 `dist/boot.js`，运行构建产物不需要复制 `node_modules`。

## 主要接口

- `GET /api/access/status`
- `POST /api/access/login`
- `POST /api/access/logout`
- `POST /api/media/resolve`
- `GET|HEAD /api/media/stream`
- `GET /api/media/poster`

媒体接口均要求有效访问会话。播放地址为短期签名地址，不是可任意指定目标的开放代理。

## 来源与许可证

解析思路参考 FetchJAV（Apache-2.0）。字体、播放引擎、测试流和其他来源见 [CREDITS.md](./CREDITS.md)；相关许可证文本位于 `licenses/`。
