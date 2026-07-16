# 部署到 GitHub Pages（静态版）

本项目原本是一个 Node/Express 服务（`app/server.js`），而 GitHub Pages 只能托管
静态文件、不能跑 Node。好在前端降级得很干净，可以做成纯静态站部署上去。

已经帮你放好了自动部署工作流：`.github/workflows/deploy-pages.yml`。
它会在每次 push 到 `main` 时，自动把前端 + 数据装配成静态站并发布。

**最终网址：** `https://sager1145.github.io/Japan-Train-Map/`

---

## 一次性设置（只做一次）

1. 把本次改动提交并推送到 GitHub：

   ```bash
   git add .github/workflows/deploy-pages.yml DEPLOY-GITHUB-PAGES.md
   git commit -m "Add GitHub Pages static deploy workflow"
   git push origin main
   ```

2. 到仓库 **Actions** 标签，等 “Deploy to GitHub Pages” 工作流跑完
   （约 1–2 分钟）。工作流里的 `configure-pages` 会用 `enablement: true`
   **自动开启 Pages**，一般不用手动设置。绿勾之后，上面那个网址就能打开。

以后每次 `git push origin main` 都会自动重新部署，无需再手动操作。

> **如果某次运行报错 “Get Pages site failed / Not Found”**：说明该仓库还没启用
> Pages，且自动开启被限制（少数账号/组织策略会这样）。手动兜底一次即可：
> **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**，
> 然后到 **Actions** 里对失败的那次点 **Re-run all jobs**。

---

## 工作流做了什么

- 把 `app/public/`（前端）复制为静态站，并排除预压缩的 `*.gz`
  （Pages 会自动 gzip）。
- 把数据集放到 `api/` 目录，文件名**不带扩展名**，以匹配前端的取数路径
  （`app.js` 里 `fetchJson("stations")` → `./api/stations`）：
  `rail-sections` / `stations` / `station-readings` / `default-trains` / `matched-routes` / `matched-stops`。
- 用你的 `app/data/train-store.json` 作为地图的**初始数据**（当前 119 趟列车），
  这样线上直接显示你的实际路线，而不是内置的演示数据。
- 加一个 `.nojekyll`，让所有文件（含无扩展名的 `api/*`）原样发布。

部署后的站点体积约 **22 MB**，远在 Pages 的单文件 100 MB / 站点约 1 GB 限制之内。

---

## 静态版：能用什么，不能用什么

**照常可用**

- 完整地图与全国铁道网、你的所有列车路线、里程统计、多语言界面。
- 在线底图（OpenFreeMap，运行时从 `tiles.openfreemap.org` 加载）。
- 在本机**保存 / 读取本地 JSON 文件**（浏览器的 File System Access API）——
  你仍然可以在线上编辑并把结果存成文件。

**会失效（已优雅降级，不会报错）**

- **保存到服务器**：`PUT /api/train-store` 没有后端可写，自动保存会静默失败；
  改动只能存到本地文件。
- **多标签实时同步**（SSE `/api/events`）：无后端推送，页面不会自动互相刷新。
- **Agent 导入**（`POST /api/agent/import`）：无后端接收。

> 想要保留这些功能，需要把后端部署到能跑 Node 的平台（Render / Railway /
> Fly.io 等），Pages 本身做不到。

---

## 常见自定义

**改初始数据 / 只发演示数据**
删掉工作流里这一行（第 3 步的 SEED），线上就只显示内置的 `default-trains`：

```
[ -f app/data/train-store.json ] && cp app/data/train-store.json _site/api/train-store || true
```

**用自定义域名**
在仓库 Settings → Pages 填 Custom domain，并在工作流的装配步骤里加一行
`echo yourdomain.com > _site/CNAME`。
