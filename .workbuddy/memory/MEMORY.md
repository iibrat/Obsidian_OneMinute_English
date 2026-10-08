# 项目长期记忆 — Obsidian One Minute English 插件

## 路径与部署

- Obsidian 库路径**两台机器不一样**：另一台是 `D:\Ivan_app\Ivan_note`；本机是 `D:\MyProjects\Ivan_note`。插件目录都是 `.obsidian/plugins/one-minute-english`。
- 部署三件套 `main.js` / `manifest.json` / `styles.css` 后要校验一致，且**绝不能动 `data.json`**。
- `main.js` 未被 git 跟踪（构建产物）；产物里中文被转义成 `\uXXXX`，grep 中文查不到，需按转义形式比对。

## 仓库结构

- worktree 布局：`main` 检出在 `D:\MyProjects\Obsidian_OneMinute_English`；AI 在 `workbuddy/main-33d84c21` 分支工作（目录 `C:\Users\Administrator\WorkBuddy\Worktrees\Obsidian_OneMinute_English\main-33d84c21`），共享同一个 `.git`。
- 远程 `github.com/iibrat/Obsidian_OneMinute_English`，主干 `main`。**两台电脑都会往 main 推，动手前必须先 `git fetch && git status` 看有没有新提交。**
  - 2026-10-08 的教训：本地长期没 fetch，不知道远程已领先 21 个提交（那条线才是「目标面板 / 自定义目录标签 / 新建笔记」的真源码），结果按旧源码把同样的功能重写了一遍，白做 700 行，最后只能 `git reset --hard origin/main` 重来。
  - 本地还有 `agent/obsidian/*` 分支（AI 工作分支）；`backup/local-reimpl-f96fc0a` 是那次白做的备份。

## 用户确认的协作规则

- **提交**：每完成一件事（改代码 + 构建 + 部署校验通过）就自动提交到 worktree 分支，中文提交说明；**不主动合并、不主动推送**，等用户明确指示才做。
- 合并：`cd D:\MyProjects\Obsidian_OneMinute_English && git merge --ff-only workbuddy/main-33d84c21`，之后 `git push origin main`。
- 构建：`pnpm run build`；pnpm 报 `ERR_PNPM_IGNORED_BUILDS` 时用 `node node_modules/typescript/bin/tsc -noEmit -skipLibCheck && node esbuild.config.mjs production` 绕过。

## 插件业务要点（易忘）

- 插件读取的笔记属性，都写在**素材笔记**里、名称可在设置改：`素材状态` / `入库时间` / `上次淘的时间` / `淘过轮次`。高亮不是属性，是正文里的 `<mark class="ome-note-highlight">`。
- `入库时间`（`settings.addedAtProperty`）：待淘排序与「入库 N 天前」都读它，**不是**文件系统时间。原因是两台电脑同步会把 `stat.ctime/birthtime` 刷成同步时间。值形如 `2026-10-08T16:58:00+08:00`，**必须带时区偏移**（不带的话 Obsidian/YAML 按 UTC 解析会差 8 小时甚至跨天）。缺失时由 `backfillAddedAt()` 用 `file.stat.ctime` 作种子补写，触发点 = 插件 `onLayoutReady` / `vault.create` / 首页视图 `onOpen`，300ms 防抖。
  - 首次补写务必在**文件时间正确的那台机器**上做（本机 `D:\MyProjects\Ivan_note`，`收集箱` 的 birthtime 有 19 个不同日期）；若在已被同步刷平的那台上补写，会写出一片相同时间。
  - 补充：Obsidian 的 `TFile.stat.ctime` 映射的是 `birthtimeMs`（真创建时间），不是 Node 的 ctime。
- 首页 tab：3 个固定 tab（`队列中` / `不在队列` / `高亮笔记`）+ `settings.customTabs` 自定义目录标签（加号添加任意目录、hover 出 × 删除）。**硬编码的「一分钟口语」tab 已删除**；tab 状态是内存态，不落盘。
- 队列排序：待淘按入库时间**新→旧**（`AGE_STALE_DAYS = 14` 起标色），已淘按最久没碰优先。
- 笔记页右下角悬浮按钮共 4 个：`移出队列/回归队列`、`下一篇`、`已阅`（已淘时显示`再淘一轮`）、`新建笔记`（在「一分钟口语目录」按 `YYYY年MM月dd日` 新建口播稿，正文 `素材状态: []` + 来源双链，`openFileBeside()` 右侧并列打开并复用相邻窗格）。素材笔记正文里的链接点击会被 `patchOpenLinkText()` 改成右侧并列打开。
- 首页底部「获取素材」「影子跟读工具」两张二维码卡片已于 2026-09-30 移除（`shadowing-tool.ts` 等文件保留，暂无人引用）。
