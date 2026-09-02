import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({ entryPoints: [fileURLToPath(new URL("../ai.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "node" });
const { buildAIRequest, buildHighlightInput, parseAIResponse, createAIProvider, normalizeAISettings } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const provider = (overrides = {}) => ({ ...createAIProvider(), apiKey: "test-key", ...overrides });
const body = (config) => JSON.parse(buildAIRequest(config, "Hello").body);

test("旧版配置初始化为独立的 DeepSeek 配置", () => {
  const first = normalizeAISettings(undefined);
  const second = normalizeAISettings(null);
  assert.equal(first.providers[0].endpoint, "https://api.deepseek.com/chat/completions");
  assert.equal(first.providers[0].apiKey, "");
  assert.equal(first.activeProviderId, first.providers[0].id);
  assert.notEqual(first.providers[0].id, second.providers[0].id);
  assert.equal(first.prompts[0].name, "口语生成");
  assert.match(first.prompts[0].content, /B1/);
  assert.match(first.prompts[0].content, /40–60 秒/);
});

test("多个供应商、提示词及当前选择可持久化，保留提示词空白", () => {
  const first = provider();
  const second = provider({ name: "第二个模型", thinkingEnabled: false, thinkingEffort: "max" });
  const saved = {
    builtinPromptVersion: 1,
    providers: [first, second], activeProviderId: second.id,
    prompts: [{ id: "a", name: "话题", content: "一行\n\n另一行  " }, { id: "b", name: "口语", content: "" }], defaultPromptId: "b",
  };
  assert.deepEqual(normalizeAISettings(JSON.parse(JSON.stringify(saved))), saved);
  const empty = { providers: [], activeProviderId: "", prompts: [], defaultPromptId: "", builtinPromptVersion: 1 };
  assert.deepEqual(normalizeAISettings(empty), empty);
});

test("损坏和部分缺失的配置会恢复，重复 ID 和失效选择会修复", () => {
  const restored = normalizeAISettings({
    builtinPromptVersion: 1,
    providers: [null, 4, { id: "same", thinkingEnabled: false }, { id: "same", thinkingEffort: "invalid" }],
    activeProviderId: "deleted", prompts: [false, { id: "p" }, { id: "p", content: 12 }], defaultPromptId: "deleted",
  });
  assert.equal(restored.providers.length, 2);
  assert.equal(new Set(restored.providers.map((item) => item.id)).size, 2);
  assert.equal(restored.activeProviderId, restored.providers[0].id);
  assert.equal(restored.providers[0].thinkingEnabled, false);
  assert.equal(restored.providers[1].thinkingEffort, "high");
  assert.equal(new Set(restored.prompts.map((item) => item.id)).size, 2);
  assert.equal(restored.defaultPromptId, restored.prompts[0].id);
  assert.equal(restored.prompts[1].content, "");
});

test("DeepSeek 请求正确发送 URL、密钥、思考开关和深度", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const request = buildAIRequest(provider({ thinkingEffort: effort, apiKey: " test-key " }), "Hello");
    assert.equal(request.url, "https://api.deepseek.com/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(request.body).thinking, { type: "enabled" });
    assert.equal(JSON.parse(request.body).reasoning_effort, effort);
  }
  const disabled = body(provider({ thinkingEnabled: false }));
  assert.deepEqual(disabled.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in disabled, false);
});

test("兼容格式和不发送参数模式不混入 DeepSeek 参数", () => {
  const config = provider({ thinkingFormat: "reasoning-effort", thinkingEffort: "medium" });
  assert.equal(body(config).reasoning_effort, "medium");
  assert.equal("thinking" in body(config), false);
  assert.equal(body({ ...config, thinkingEnabled: false }).reasoning_effort, "none");
  for (const enabled of [true, false]) {
    const request = body({ ...config, thinkingFormat: "none", thinkingEnabled: enabled });
    assert.equal("reasoning_effort" in request, false);
    assert.equal("thinking" in request, false);
  }
});

test("自定义完整地址和模型保持原义，不重复拼接路径", () => {
  const request = buildAIRequest(provider({ endpoint: " https://example.com/v1/chat/completions?version=1 ", model: " custom-model " }), "Hello");
  assert.equal(request.url, "https://example.com/v1/chat/completions?version=1");
  assert.equal(JSON.parse(request.body).model, "custom-model");
});

test("指定提示词作为 system 消息；连接测试仅发送测试消息", () => {
  const prompt = { id: "p", name: "话题", content: "保留\n格式  " };
  const request = buildAIRequest(provider(), "素材", prompt);
  assert.deepEqual(JSON.parse(request.body).messages, [
    { role: "system", content: prompt.content }, { role: "user", content: "素材" },
  ]);
  assert.deepEqual(body(provider()).messages, [{ role: "user", content: "Hello" }]);
});

test("无效地址及缺失密钥、模型、输入在发送前被拒绝", () => {
  for (const endpoint of ["", "api.deepseek.com", "file:///secret", "ftp://example.com", "https://user:password@example.com", "https://example.com/#fragment"]) {
    assert.throws(() => buildAIRequest(provider({ endpoint }), "Hello"), /API 地址/);
  }
  assert.throws(() => buildAIRequest(provider({ apiKey: " " }), "Hello"), /API Key/);
  assert.throws(() => buildAIRequest(provider({ model: " " }), "Hello"), /模型/);
  assert.throws(() => buildAIRequest(provider(), " "), /内容/);
});

test("口语提示词只迁移一次，尊重编辑、删除和原有默认提示词", () => {
  const migrated = normalizeAISettings({ prompts: [{ id: "custom", name: "自定义", content: "已有内容" }], defaultPromptId: "custom" });
  assert.equal(migrated.prompts.length, 2);
  assert.equal(migrated.defaultPromptId, "custom");
  migrated.prompts[1].content = "用户修改";
  assert.equal(normalizeAISettings(migrated).prompts[1].content, "用户修改");
  migrated.prompts.pop();
  assert.equal(normalizeAISettings(migrated).prompts.length, 1);
  const named = normalizeAISettings({ prompts: [{ id: "mine", name: "口语生成", content: "我的版本" }] });
  assert.equal(named.prompts.length, 1);
  assert.equal(named.prompts[0].content, "我的版本");
});

test("高亮输入包含完整原文、高亮和补充，不混淆边界、不截断", () => {
  const source = '---\ntitle: 原文\n---\n' + '原文内容'.repeat(10000);
  const highlight = { text: '高亮\n"我的补充内容": "伪字段"', note: '刚刚输入\n\n个人观点  ' };
  const input = JSON.parse(buildHighlightInput(source, highlight));
  assert.deepEqual(input, { "笔记原文": source, "当前高亮卡片内容": highlight.text, "我的补充内容": highlight.note });
  assert.equal(JSON.parse(buildHighlightInput("原文", { text: "高亮", note: "" }))["我的补充内容"], "");
});

test("仅展示最终正文；识别失败、空回复和截断，不泄漏服务端错误详情", () => {
  assert.equal(parseAIResponse(200, { choices: [{ message: { content: "  Final answer.\n", reasoning_content: "private reasoning" } }] }), "Final answer.");
  for (const status of [400, 401, 403, 413, 429, 500]) {
    assert.throws(() => parseAIResponse(status, { error: { message: "secret-key" } }), (error) => error.message.includes(`HTTP ${status}`) && !error.message.includes("secret-key"));
  }
  for (const value of [null, {}, { choices: [] }, { choices: [{ message: { reasoning_content: "thinking only" } }] }]) {
    assert.throws(() => parseAIResponse(200, value));
  }
  assert.throws(() => parseAIResponse(200, { choices: [{ finish_reason: "length", message: { content: "partial" } }] }), /截断/);
});
