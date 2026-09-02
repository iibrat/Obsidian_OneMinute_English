import { SPEAKING_PROMPT } from "./ai-prompts";

export type ThinkingFormat = "deepseek" | "reasoning-effort" | "none";
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AIProvider {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  thinkingFormat: ThinkingFormat;
  thinkingEnabled: boolean;
  thinkingEffort: ThinkingEffort;
}

export interface AIPrompt {
  id: string;
  name: string;
  content: string;
}

export interface AIResult {
  content: string;
  promptName: string;
  model: string;
  createdAt: number;
}

export function getHighlightAIResults(highlight: { aiResult?: AIResult; aiResults?: AIResult[] }): AIResult[] {
  if (highlight.aiResults?.length) return highlight.aiResults;
  return highlight.aiResult ? [highlight.aiResult] : [];
}

export interface AISettings {
  providers: AIProvider[];
  activeProviderId: string;
  prompts: AIPrompt[];
  defaultPromptId: string;
  builtinPromptVersion?: number;
}

export function createAIId(): string {
  return globalThis.crypto.randomUUID();
}

export function createAIProvider(): AIProvider {
  return {
    id: createAIId(),
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    apiKey: "",
    model: "deepseek-v4-flash",
    thinkingFormat: "deepseek",
    thinkingEnabled: true,
    thinkingEffort: "high",
  };
}

export function normalizeAISettings(value: unknown): AISettings {
  const saved = isRecord(value) ? value : {};
  const providerIds = new Set<string>();
  const providers = Array.isArray(saved.providers)
    ? saved.providers.filter(isRecord).map((item): AIProvider => {
      const defaults = createAIProvider();
      const id = uniqueId(item.id, providerIds);
      const format = item.thinkingFormat;
      const effort = item.thinkingEffort;
      return {
        id,
        name: stringOr(item.name, defaults.name),
        endpoint: stringOr(item.endpoint, defaults.endpoint),
        apiKey: stringOr(item.apiKey, ""),
        model: stringOr(item.model, defaults.model),
        thinkingFormat: format === "reasoning-effort" || format === "none" ? format : "deepseek",
        thinkingEnabled: typeof item.thinkingEnabled === "boolean" ? item.thinkingEnabled : true,
        thinkingEffort: effort === "low" || effort === "medium" || effort === "xhigh" || effort === "max" ? effort : "high",
      };
    })
    : [createAIProvider()];
  const promptIds = new Set<string>();
  const prompts = Array.isArray(saved.prompts)
    ? saved.prompts.filter(isRecord).map((item): AIPrompt => ({
      id: uniqueId(item.id, promptIds),
      name: stringOr(item.name, "未命名提示词"),
      content: stringOr(item.content, ""),
    }))
    : [];
  if (saved.builtinPromptVersion !== 1 && !prompts.some((prompt) => prompt.id === SPEAKING_PROMPT.id || prompt.name === SPEAKING_PROMPT.name)) {
    prompts.push({ ...SPEAKING_PROMPT });
  }
  return {
    builtinPromptVersion: 1,
    providers,
    activeProviderId: providers.find((provider) => provider.id === saved.activeProviderId)?.id ?? providers[0]?.id ?? "",
    prompts,
    defaultPromptId: prompts.find((prompt) => prompt.id === saved.defaultPromptId)?.id ?? prompts[0]?.id ?? "",
  };
}

export function buildHighlightInput(source: string, highlight: { text: string; note: string }): string {
  return JSON.stringify({
    "笔记原文": source,
    "当前高亮卡片内容": highlight.text,
    "我的补充内容": highlight.note,
  }, null, 2);
}

export function parseAIResponse(status: number, data: unknown): string {
  if (status < 200 || status >= 300) {
    const hints: Record<number, string> = {
      400: "请检查模型和思考参数，或确认原文是否超过模型长度限制。",
      401: "请检查 API Key。", 402: "请检查账户余额。", 403: "请检查密钥权限。",
      404: "请检查 API 地址和模型名称。", 413: "原文超过接口支持的长度。",
      422: "请检查模型支持的请求参数。", 429: "请求过于频繁或额度不足，请稍后重试。",
    };
    throw new Error(`请求失败（HTTP ${status}）。${hints[status] ?? "请稍后重试或检查供应商服务状态。"}`);
  }
  const choices = isRecord(data) && Array.isArray(data.choices) ? data.choices : [];
  const choice = choices[0];
  if (!isRecord(choice)) throw new Error("接口未返回有效回复，请检查接口兼容性。");
  if (choice.finish_reason === "length") throw new Error("回复达到模型长度限制而被截断，请降低思考深度或缩短材料后重试。");
  const message = choice.message;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== "string" || !content.trim()) throw new Error("模型未返回正文，请检查模型配置或稍后重试。");
  return content.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function uniqueId(value: unknown, used: Set<string>): string {
  const id = typeof value === "string" && value && !used.has(value) ? value : createAIId();
  used.add(id);
  return id;
}

export function buildAIRequest(provider: AIProvider, input: string, prompt?: AIPrompt): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
} {
  let url: URL;
  try {
    url = new URL(provider.endpoint.trim());
  } catch {
    throw new Error("请输入完整的 API 地址，例如 https://api.deepseek.com/chat/completions");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("API 地址须为 HTTP 或 HTTPS，且不能包含用户名、密码或锚点。");
  }
  if (!provider.apiKey.trim()) throw new Error("请先填写 API Key。");
  if (!provider.model.trim()) throw new Error("请先填写模型名称。");
  if (!input.trim()) throw new Error("请输入发送给 AI 的内容。");

  const messages = [];
  if (prompt?.content.trim()) messages.push({ role: "system", content: prompt.content });
  messages.push({ role: "user", content: input });
  const body: Record<string, unknown> = { model: provider.model.trim(), messages, stream: false };
  if (provider.thinkingFormat === "deepseek") {
    body.thinking = { type: provider.thinkingEnabled ? "enabled" : "disabled" };
    if (provider.thinkingEnabled) body.reasoning_effort = provider.thinkingEffort;
  } else if (provider.thinkingFormat === "reasoning-effort") {
    body.reasoning_effort = provider.thinkingEnabled ? provider.thinkingEffort : "none";
  }
  return {
    url: url.toString(),
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey.trim()}` },
    body: JSON.stringify(body),
  };
}
