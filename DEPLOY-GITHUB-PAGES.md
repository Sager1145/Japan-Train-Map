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

- **离线预解算示例数据**（`node app/scripts/precompute-train-parts.mjs`）：在 CI 里把
  `train-store.json`（示例数据的来源）中每趟列车的路线几何用 app.js 自己的
  解算器提前算好，导出成 `api/sample-data/`：manifest（含**按日期分组**的索引）
  + 每趟一个 `part-NNN.json` 小文件。静态站开机时**一次加载并显示一趟**，
  手机端完全不跑路线解算（此前 iPhone 打开即崩的根因就是开机在手机上
  冷解算全部路线导致内存爆掉）。
- 把 `app/public/`（前端）复制为静态站，并排除预压缩的 `*.gz`
  （Pages 会自动 gzip）。
- 把数据集放到 `api/` 目录，文件名**带 `.json` 扩展名**（Pages 只压缩已知类型），
  并把前端取数路径改写成 `./api/<name>.json`。
- `train-store.json` 本身**不再发布**——线上它只是示例数据的生成来源；
  访客的数据保存在各自浏览器里（见下）。
- 加一个 `.nojekyll`，让所有文件原样发布。

部署后的站点体积约 **22 MB**，远在 Pages 的单文件 100 MB / 站点约 1 GB 限制之内。

---

## 静态版的数据模型：示例数据 vs 访客自己的数据

- **示例数据（sample data）**：即你 push 上去的 train-store 内容，按日期拆成
  小文件发布在 `api/sample-data/`（每趟列车一个 `part-NNN.json`），同时保留
  一份完整合并版 `api/sample-data/sample-full.json`（一个大 JSON，可整体
  下载 / 匯入）。**只读、无记忆**——访客怎么改都不会保存。
- **匯入仍然接受一个大文件**：在「资料」页签贴入完整 store JSON（或打开本地
  大 JSON 文件）即可；保存时会自动**按日期拆成小块**写入浏览器存储。示例
  模式下匯入会先询问是否作为「我的资料」保存。
- **访客自己的数据**：保存在访客浏览器的 IndexedDB 里，**按日期分块**
  （一天一条记录，附带该日已解算的路线几何），编辑时自动保存。
- **开机逻辑**：有自己保存的数据 → 直接显示自己的数据；没有 → 随机加载
  **一天**的示例数据（体验轻、加载快）。
- 「资料」页签新增**资料来源**区：
  - **载入全部示例资料**（有确认弹窗）：查看全部日期的示例；不会碰访客已保存的数据。
  - **保存为我的资料**：把当前画面内容存进浏览器（若已有保存会先警告覆盖）。
  - **恢复我的资料**：从示例视图一键回到自己保存的数据。
  - 危险区域的「清除保存资料」现在清除的是浏览器里的 IndexedDB 存储。

**照常可用**

- 完整地图与全国铁道网、里程统计、多语言界面。
- 在线底图（OpenFreeMap，运行时从 `tiles.openfreemap.org` 加载）。
- 在本机**保存 / 读取本地 JSON 文件**（浏览器的 File System Access API）——
  打开本地 JSON 会视为「载入我的资料」并自动保存到浏览器。

**会失效（已优雅降级，不会报错）**

- **保存到服务器**：无后端；自动保存改为写入浏览器 IndexedDB。
- **多标签实时同步**（SSE `/api/events`）：无后端推送，页面不会自动互相刷新。
- **Agent 导入**（`POST /api/agent/import`）：无后端接收。

> 想要跨设备同步 / 多人共享数据，需要把后端部署到能跑 Node 的平台
> （Render / Railway / Fly.io 等），或接入 Supabase 这类云端存储，
> Pages 本身做不到。

---

## 常见自定义

**改示例数据**
本地用 Node 版（`npm start`）编辑，改动自动写回 `app/data/train-store.json`，
push 后 CI 会自动重新生成按日期拆分的 `api/sample-data/`。

**内存受限环境下手动预解算**（一般用不到；CI 会自动跑）：

```
PRECOMPUTE_RANGE=0:20  node app/scripts/precompute-train-parts.mjs   # 分段解算
PRECOMPUTE_RANGE=20:40 node app/scripts/precompute-train-parts.mjs   # …直到跑完
PRECOMPUTE_FINALIZE=1  node app/scripts/precompute-train-parts.mjs   # 生成 manifest
```

**用自定义域名**
在仓库 Settings → Pages 填 Custom domain，并在工作流的装配步骤里加一行
`echo yourdomain.com > _site/CNAME`。
