import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../main.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"] });

function noteResponse(content = "Generated speech.", title = "A Fresh Perspective") {
  return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title, content }) } }] }) };
}

function setup() {
  const requests = [];
  const notices = [];
  const menus = [];
  const files = new Map();
  const created = [];
  const opened = [];
  const operations = [];
  let response = async () => noteResponse();
  class Element {
    addClass() {}
    empty() {}
    createEl() { return new Element(); }
  }
  class Modal {
    contentEl = new Element();
    modalEl = new Element();
    open() { this.onOpen(); }
    close() { this.onClose(); }
  }
  class Setting {
    addButton(callback) {
      const button = { setButtonText() { return this; }, setCta() { return this; }, onClick() { return this; } };
      callback(button);
      return this;
    }
  }
  class TFile {
    constructor(path = "source.md") { this.path = path; }
    get basename() { return this.path.split("/").pop().replace(/\.md$/, ""); }
  }
  class TFolder { path = "topics"; }
  class MarkdownView {
    file = new TFile();
    editor = { getValue: () => "Unsaved original text" };
    getMode() { return "source"; }
  }
  class Menu {
    items = [];
    constructor() { menus.push(this); }
    addItem(callback) {
      const item = { setTitle(value) { this.title = value; return this; }, setIcon() { return this; }, setDisabled(value) { this.disabled = value; return this; }, onClick(value) { this.click = value; return this; } };
      callback(item); this.items.push(item); return this;
    }
    addSeparator() {}
    showAtPosition() {}
  }
  class Plugin {
    async saveData(data) { this.saved = JSON.parse(JSON.stringify(data)); }
  }
  const obsidian = {
    Modal, Setting, TFile, TFolder, MarkdownView, Menu, Plugin,
    normalizePath: (path) => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/"),
    FuzzySuggestModal: class {}, ItemView: class {}, PluginSettingTab: class {},
    Notice: class { constructor(message) { notices.push(message); } },
    requestUrl: async (request) => { requests.push(request); return response(); },
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: () => obsidian, URL, setTimeout, clearTimeout,
    crypto: globalThis.crypto,
  });
  const plugin = new module.exports.default();
  const sourceFile = new TFile();
  files.set(sourceFile.path, sourceFile);
  files.set("topics", new TFolder());
  const editor = new MarkdownView();
  let reads = 0;
  plugin.app = {
    vault: {
      getAbstractFileByPath: (path) => { operations.push({ type: "lookup", path }); return files.get(path) ?? null; },
      read: async () => { reads++; return "Saved original text"; },
      create: async (path, content) => {
        operations.push({ type: "create", path });
        if (files.has(path)) throw new Error("Already exists");
        const file = new TFile(path);
        files.set(path, file);
        created.push({ path, content });
        return file;
      },
    },
    fileManager: { generateMarkdownLink: (file) => `[[${file.path.replace(/\.md$/, "")}]]` },
    workspace: { getLeavesOfType: () => [{ view: editor }], getLeaf: () => ({ openFile: async (file) => opened.push(file.path) }) },
  };
  const highlight = { id: "h", sourcePath: "source.md", text: "Highlighted passage", note: "Latest supplement", createdAt: 1 };
  const prompt = { id: "p", name: "口语生成", content: "Write B1 American English." };
  plugin.settings = {
    topicFolder: "topics", statusProperty: "状态",
    highlights: [highlight],
    ai: { providers: [{ id: "provider", name: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", model: "test-model", apiKey: "test-key", thinkingFormat: "deepseek", thinkingEnabled: true, thinkingEffort: "high" }], activeProviderId: "provider", prompts: [prompt], defaultPromptId: "p" },
  };
  return { plugin, highlight, prompt, requests, notices, menus, editor, files, created, opened, operations, reads: () => reads, respond: (fn) => { response = fn; } };
}

test("菜单包含设置中的提示词，选择后携带当前编辑器原文和补充并保存结果", async () => {
  const ctx = setup();
  ctx.plugin.showHighlightAIMenu(ctx.highlight, { getBoundingClientRect: () => ({ left: 1, bottom: 2 }), ownerDocument: {} });
  assert.equal(ctx.menus[0].items[0].title, "口语生成");
  ctx.menus[0].items[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.requests.length, 1);
  const body = JSON.parse(ctx.requests[0].body);
  assert.ok(body.messages[0].content.startsWith(ctx.prompt.content));
  assert.match(body.messages[0].content, /"title"/);
  assert.match(body.messages[0].content, /"content"/);
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    "笔记原文": "Unsaved original text", "当前高亮卡片内容": "Highlighted passage", "我的补充内容": "Latest supplement",
  });
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(ctx.reads(), 0);
  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.created[0].path, "topics/A Fresh Perspective.md");
  assert.deepEqual(ctx.operations.filter((op) => op.path === ctx.created[0].path).map((op) => op.type), ["create"]);
  assert.equal(ctx.plugin.saved.highlights[0].aiNotes[0].path, ctx.created[0].path);
  assert.match(ctx.created[0].content, /Generated speech\./);
  assert.match(ctx.created[0].content, /## 来源笔记\n\n\[\[source\]\]/);
  assert.match(ctx.created[0].content, /"状态": \[\]/);
  assert.equal(ctx.highlight.aiResult, undefined);
  assert.equal(ctx.highlight.aiResults, undefined);
});

test("其他笔记处于活动状态时仍读取高亮自己的原文；重复提交被阻止", async () => {
  const ctx = setup();
  ctx.editor.file.path = "unrelated.md";
  let resolve;
  ctx.respond(() => new Promise((done) => { resolve = done; }));
  const pending = ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  await new Promise((done) => setImmediate(done));
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.reads(), 1);
  assert.equal(JSON.parse(JSON.parse(ctx.requests[0].body).messages[1].content)["笔记原文"], "Saved original text");
  resolve(noteResponse("Success"));
  await pending;
});

test("无原文或空提示词不请求 API；接口失败保留上次结果且可再次提交", async () => {
  const ctx = setup();
  await ctx.plugin.generateHighlightAI(ctx.highlight, { ...ctx.prompt, content: " " });
  assert.equal(ctx.requests.length, 0);
  const originalLookup = ctx.plugin.app.vault.getAbstractFileByPath;
  ctx.plugin.app.vault.getAbstractFileByPath = (path) => path === "source.md" ? null : originalLookup(path);
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.requests.length, 0);
  ctx.plugin.app.vault.getAbstractFileByPath = originalLookup;
  ctx.highlight.aiResult = { content: "Previous result" };
  ctx.respond(async () => ({ status: 401, text: '{"error":"secret-key"}' }));
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.highlight.aiResult.content, "Previous result");
  assert.equal(ctx.plugin.pendingAI.size, 0);
  ctx.respond(async () => noteResponse("Retried result"));
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.highlight.aiResult.content, "Previous result");
  assert.match(ctx.created[0].content, /Retried result/);
});

test("连续生成创建独立话题笔记，卡片仅保存链接并保留旧版历史", async () => {
  const ctx = setup();
  ctx.highlight.aiResult = { content: "Legacy result", promptName: "旧提示词", model: "old-model", createdAt: 1 };
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  await ctx.plugin.generateHighlightAI(ctx.highlight, { ...ctx.prompt, name: "第二条提示词" });
  assert.equal(ctx.created.length, 2);
  assert.notEqual(ctx.created[0].path, ctx.created[1].path);
  assert.deepEqual(ctx.plugin.saved.highlights[0].aiNotes.map((note) => note.path), ctx.created.map((note) => note.path));
  assert.equal(ctx.plugin.saved.highlights[0].aiNotes[1].promptName, "第二条提示词");
  assert.equal(ctx.highlight.aiResult.content, "Legacy result");
  assert.equal(ctx.highlight.aiResults, undefined);
  assert.equal(ctx.highlight.text, "Highlighted passage");
  assert.equal(ctx.highlight.note, "Latest supplement");
  ctx.respond(async () => ({ status: 500, text: "error" }));
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.highlight.aiNotes.length, 2);
  assert.equal(ctx.created.length, 2);
});

test("话题目录未配置或不存在时先提示，不调用 AI 或创建笔记", async () => {
  for (const path of ["", " ", "missing", "source.md"]) {
    const ctx = setup();
    ctx.plugin.settings.topicFolder = path;
    await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
    assert.equal(ctx.requests.length, 0);
    assert.equal(ctx.created.length, 0);
    assert.match(ctx.notices[0], /话题目录/);
  }
});

test("新笔记或文件夹重命名后卡片链接可打开正确文件", async () => {
  const ctx = setup();
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  const oldPath = ctx.created[0].path;
  const file = ctx.files.get(oldPath);
  ctx.files.delete(oldPath);
  file.path = "topics/renamed.md";
  ctx.files.set(file.path, file);
  await ctx.plugin.updateHighlightPaths(file.path, oldPath);
  assert.equal(ctx.plugin.saved.highlights[0].aiNotes[0].path, file.path);
  await ctx.plugin.openAINote(ctx.highlight.aiNotes[0].path);
  assert.deepEqual(ctx.opened, [file.path]);
  await ctx.plugin.updateHighlightPaths("moved-topics", "topics");
  assert.equal(ctx.highlight.aiNotes[0].path, "moved-topics/renamed.md");
});

test("创建笔记失败不会保存虚假卡片链接或覆盖旧笔记", async () => {
  const ctx = setup();
  let attempts = 0;
  ctx.plugin.app.vault.create = async () => { attempts++; throw new Error("Disk full"); };
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.highlight.aiNotes, undefined);
  assert.equal(ctx.plugin.pendingAI.size, 0);
  assert.equal(attempts, 1);
});

test("先保存，发生同名错误后才添加时间戳，保留原文件", async () => {
  const ctx = setup();
  const create = ctx.plugin.app.vault.create;
  let collisionPath;
  ctx.plugin.app.vault.create = async (path, content) => {
    if (!collisionPath) {
      collisionPath = path;
      await create(path, "Existing document");
      throw new Error("Already exists");
    }
    return create(path, content);
  };
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.created[0].content, "Existing document");
  assert.equal(collisionPath, "topics/A Fresh Perspective.md");
  assert.match(ctx.created[1].path, /^topics\/A Fresh Perspective-\d+\.md$/);
  assert.deepEqual(ctx.operations.filter((op) => op.path === collisionPath).map((op) => op.type), ["create", "lookup"]);
  assert.deepEqual(ctx.operations.filter((op) => op.path === ctx.created[1].path).map((op) => op.type), ["create"]);
  assert.equal(ctx.highlight.aiNotes[0].path, ctx.created[1].path);
});

test("AI 没有返回标题时不使用固定名称创建笔记", async () => {
  const ctx = setup();
  ctx.respond(async () => noteResponse("Generated speech.", ""));
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.highlight.aiNotes, undefined);
  assert.equal(ctx.plugin.pendingAI.size, 0);
});
