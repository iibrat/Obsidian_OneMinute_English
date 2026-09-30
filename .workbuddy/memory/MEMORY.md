# 项目长期记忆 — Obsidian One Minute English 插件

## 路径与部署

- Obsidian 库：`D:\Ivan_app\Ivan_note`（旧的 `D:\MyProjects\Ivan_note` 已失效）。插件目录 `.obsidian/plugins/one-minute-english`。
- 部署三件套 `main.js` / `manifest.json` / `styles.css` 后要校验一致，且**绝不能动 `data.json`**。
- `main.js` 未被 git 跟踪（构建产物）；产物里中文被转义成 `\uXXXX`，grep 中文查不到，需按转义形式比对。

## 仓库结构

- worktree 布局：`main` 检出在 `D:\MyProjects\Obsidian_OneMinute_English`；AI 在 `workbuddy/main-33d84c21` 分支工作（目录 `C:\Users\Administrator\WorkBuddy\Worktrees\Obsidian_OneMinute_English\main-33d84c21`），共享同一个 `.git`。

## 用户确认的协作规则

- **提交**：每完成一件事（改代码 + 构建 + 部署校验通过）就自动提交到 worktree 分支，中文提交说明；**不主动合并、不主动推送**，等用户明确指示才做。
- 合并：`cd D:\MyProjects\Obsidian_OneMinute_English && git merge --ff-only workbuddy/main-33d84c21`，之后 `git push origin main`。
- 构建：`pnpm run build`；pnpm 报 `ERR_PNPM_IGNORED_BUILDS` 时用 `node node_modules/typescript/bin/tsc -noEmit -skipLibCheck && node esbuild.config.mjs production` 绕过。

## 插件业务要点（易忘）

- 插件读取的笔记属性只有三个，都写在**素材笔记**里、名称可在设置改：`素材状态` / `上次淘的时间` / `淘过轮次`。高亮不是属性，是正文里的 `<mark class="ome-note-highlight">`。
- 首页 tab：`队列中` / `不在队列` / `高亮笔记` / `一分钟口语`（tab 状态是内存态，不落盘）。前两个 tab 有二维码 footer，后两个没有。
- 队列排序：待淘按入库时间**新→旧**（`AGE_STALE_DAYS = 14` 起标色），已淘按最久没碰优先。
- 笔记页右下角悬浮按钮：`移出队列/回归队列`、`下一篇`、`已阅`（已淘时显示`再淘一轮`）。
- 首页底部「获取素材」「影子跟读工具」两张二维码卡片已于 2026-09-30 移除（`shadowing-tool.ts` 等文件保留，暂无人引用）。
