# 项目约定

- `D:\MyProjects\Ivan_note` 是用户的 Obsidian 库目录。
- 修改插件后，完成构建，并将 `main.js`、`manifest.json`、`styles.css` 部署到 `D:\MyProjects\Ivan_note\.obsidian\plugins\one-minute-english`。
- 部署时保留插件目录中的 `data.json` 及其他用户数据，不要覆盖或删除。
- 部署后校验这三个文件与项目构建产物一致，并告知用户部署结果；如未重新加载插件，明确说明需重新加载后生效。
- GitHub 提交说明和版本发布说明使用中文。发布版本时同步更新版本文件，并新增 `release-notes/<版本号>.md`，供标签触发的发布流程使用。
