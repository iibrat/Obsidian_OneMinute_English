import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../main.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"] });

function setup() {
  const requests = [];
  const notices = [];
  const menus = [];
  let response = async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: "Generated speech." } }] }) });
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
  class TFile { path = "source.md"; }
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
    Modal, Setting, TFile, MarkdownView, Menu, Plugin,
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
  const editor = new MarkdownView();
  let reads = 0;
  plugin.app = {
    vault: { getAbstractFileByPath: () => sourceFile, read: async () => { reads++; return "Saved original text"; } },
    workspace: { getLeavesOfType: () => [{ view: editor }] },
  };
  const highlight = { id: "h", sourcePath: "source.md", text: "Highlighted passage", note: "Latest supplement", createdAt: 1 };
  const prompt = { id: "p", name: "口语生成", content: "Write B1 American English." };
  plugin.settings = {
    highlights: [highlight],
    ai: { providers: [{ id: "provider", name: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", model: "test-model", apiKey: "test-key", thinkingFormat: "deepseek", thinkingEnabled: true, thinkingEffort: "high" }], activeProviderId: "provider", prompts: [prompt], defaultPromptId: "p" },
  };
  return { plugin, highlight, prompt, requests, notices, menus, editor, reads: () => reads, respond: (fn) => { response = fn; } };
}

test("菜单包含设置中的提示词，选择后携带当前编辑器原文和补充并保存结果", async () => {
  const ctx = setup();
  ctx.plugin.showHighlightAIMenu(ctx.highlight, { getBoundingClientRect: () => ({ left: 1, bottom: 2 }), ownerDocument: {} });
  assert.equal(ctx.menus[0].items[0].title, "口语生成");
  ctx.menus[0].items[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.requests.length, 1);
  const body = JSON.parse(ctx.requests[0].body);
  assert.equal(body.messages[0].content, ctx.prompt.content);
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    "笔记原文": "Unsaved original text", "当前高亮卡片内容": "Highlighted passage", "我的补充内容": "Latest supplement",
  });
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(ctx.reads(), 0);
  assert.equal(ctx.plugin.saved.highlights[0].aiResult.content, "Generated speech.");
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
  resolve({ status: 200, text: JSON.stringify({ choices: [{ message: { content: "Success" } }] }) });
  await pending;
});

test("无原文或空提示词不请求 API；接口失败保留上次结果且可再次提交", async () => {
  const ctx = setup();
  await ctx.plugin.generateHighlightAI(ctx.highlight, { ...ctx.prompt, content: " " });
  assert.equal(ctx.requests.length, 0);
  const originalLookup = ctx.plugin.app.vault.getAbstractFileByPath;
  ctx.plugin.app.vault.getAbstractFileByPath = () => null;
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.requests.length, 0);
  ctx.plugin.app.vault.getAbstractFileByPath = originalLookup;
  ctx.highlight.aiResult = { content: "Previous result" };
  ctx.respond(async () => ({ status: 401, text: '{"error":"secret-key"}' }));
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.highlight.aiResult.content, "Previous result");
  assert.equal(ctx.plugin.pendingAI.size, 0);
  ctx.respond(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: "Retried result" } }] }) }));
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.highlight.aiResult.content, "Retried result");
});

test("连续生成逐条追加并持久化，兼容旧版结果且不改写高亮和补充", async () => {
  const ctx = setup();
  ctx.highlight.aiResult = { content: "Legacy result", promptName: "旧提示词", model: "old-model", createdAt: 1 };
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  await ctx.plugin.generateHighlightAI(ctx.highlight, { ...ctx.prompt, name: "第二条提示词" });
  assert.deepEqual(ctx.plugin.saved.highlights[0].aiResults.map((result) => result.content), ["Legacy result", "Generated speech.", "Generated speech."]);
  assert.equal(ctx.plugin.saved.highlights[0].aiResults[2].promptName, "第二条提示词");
  assert.equal(ctx.highlight.text, "Highlighted passage");
  assert.equal(ctx.highlight.note, "Latest supplement");
  ctx.respond(async () => ({ status: 500, text: "error" }));
  await ctx.plugin.generateHighlightAI(ctx.highlight, ctx.prompt);
  assert.equal(ctx.highlight.aiResults.length, 3);
});
