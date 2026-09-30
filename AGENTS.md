# 项目约定

- Obsidian 库目录是 `D:\Ivan_app\Ivan_note`（旧路径 `D:\MyProjects\Ivan_note` 已失效）。
- 修改插件后，完成构建，并将 `main.js`、`manifest.json`、`styles.css` 部署到 `D:\Ivan_app\Ivan_note\.obsidian\plugins\one-minute-english`。
- 部署时保留插件目录中的 `data.json` 及其他用户数据，不要覆盖或删除。
- 部署后校验这三个文件与项目构建产物一致，并告知用户部署结果；如未重新加载插件，明确说明需重新加载后生效。
- GitHub 提交说明和版本发布说明使用中文。发布版本时同步更新版本文件，并新增 `release-notes/<版本号>.md`，供标签触发的发布流程使用。

## 分支与合并

- 本仓库是一个 git worktree 布局：`main` 检出在 `D:\MyProjects\Obsidian_OneMinute_English`，AI 的改动发生在 `workbuddy/main-33d84c21` 分支（工作目录 `C:\Users\Administrator\WorkBuddy\Worktrees\Obsidian_OneMinute_English\main-33d84c21`）。
- 合并流程：先在 worktree 分支提交，再到 `D:\MyProjects\Obsidian_OneMinute_English` 执行 `git merge workbuddy/main-33d84c21`（两条分支无分叉时是快进合并），最后 `git push origin main`。
- **提交规则（用户已确认，默认执行）**：每完成一件事（代码改动 + 构建 + 部署校验通过）就在 worktree 分支**立即自动提交**一次，提交说明用中文。**不主动合并、不主动推送** —— 合并到 `main` 和 `git push` 都必须等用户明确指示。
- 每笔提交只包含本次改动涉及的文件；`.workbuddy/memory/` 下的工作日志可以随本次改动一起提交。
- 构建：`pnpm run build`（= `tsc -noEmit -skipLibCheck` + `node esbuild.config.mjs production`）。若 pnpm 预检查报 `ERR_PNPM_IGNORED_BUILDS`，可直接用 `node node_modules/typescript/bin/tsc -noEmit -skipLibCheck && node esbuild.config.mjs production` 绕过，产物相同。
- 构建产物 `main.js` 里中文会被转义成 `\uXXXX`，校验时用 Python 按转义形式比对，直接 grep 中文会得到 0 结果。
