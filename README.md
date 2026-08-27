# One Minute English

一个用于集中管理英语素材和话题进度的 Obsidian 仪表盘插件。

我一直想把英语学好，网上看了各种学英语的方法但感觉都不管用，其实根本问题还是对学习的理解有误，一直在学习方法、技巧之类的，很少有花时间真正去练习英语。

当我意识到这一点，我开始尝试着每天用英语写点什么，然后录成视频说出来。但新的问题又出现了，我好像没有什么话说，半天憋不出3句话来。

最近我想到一个办法，也许能解决没话说的问题，我做了这个 obsidian 插件，配合 Claudian 插件。平时先收集各种感兴趣的素材，然后用AI从素材中提取各种话题，并且指导我针对这个话题写一段一分钟的英语内容。平时收集自己感兴趣的素材，然后用 AI 从素材中提取话题，并且引导我写一段一分钟的英语口语表达内容。

这个插件其实跟整个学过过程没有关系，只是一种我个人比较喜欢的展示方式，整体页面设计是抄另一个插件的。https://github.com/kuzzh/obsidian-startpage

插件需要配合 Claudian 之类的AI插件使用，至于怎么配置请自行搞定。
还需要一段 AI 提示词，用来从素材中提取话题，我有一个自己用的，放在“AI角色” 目录，大概逻辑是“从素材中提取话题，把每个话题生成一个md文档，放在指定的目录中，并且对话题和素材进行双向链接。”



## 使用

1. 安装依赖并构建：`npm install`、`npm run build`。
2. 将 `manifest.json`、`main.js`、`styles.css` 复制到库内 `.obsidian/plugins/one-minute-english/`。
3. 在 Obsidian 的“第三方插件”中启用 **One Minute English**。
4. 打开插件设置，选择素材目录、话题目录，并配置话题状态属性。
5. 点击左侧边栏的语言图标，或在命令面板执行“打开主页”。

## 发布新版本

项目已配置 GitHub Actions。推送与 `manifest.json` 版本号相同的 Git 标签后，会自动构建插件、创建 GitHub Release，并上传 `main.js`、`manifest.json`、`styles.css` 和安装 ZIP。

例如发布 `1.0.1`：

```powershell
npm run version:set -- 1.0.1
npm run build
git add manifest.json versions.json package.json main.js
git commit -m "Release 1.0.1"
git push origin main
git tag 1.0.1
git push origin 1.0.1
```

标签必须使用 `1.0.1` 这种格式，不要添加 `v`，并且必须与 `manifest.json` 中的 `version` 完全一致。发布进度可在仓库的 **Actions** 页面查看，完成后版本会显示在仓库右侧的 **Releases** 区域。
