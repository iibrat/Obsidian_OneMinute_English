import { App, Modal, Setting, requestUrl } from "obsidian";
import {
  AIPrompt, AISettings, ThinkingEffort, ThinkingFormat, buildAIRequest, createAIId, createAIProvider,
} from "./ai";
import { AIPromptModal } from "./ai-prompt-modal";

export function renderAISettings(container: HTMLElement, app: App, ai: AISettings, save: () => Promise<void>): void {
  const render = (): void => renderAISettings(container, app, ai, save);
  container.empty();
  container.createEl("h3", { text: "AI 供应商" });
  container.createEl("p", {
    cls: "setting-item-description",
    text: "保存多套供应商或模型配置，并选择当前使用的一套。支持 Chat Completions 兼容接口，修改后自动保存。",
  });
  const selector = new Setting(container).setName("当前供应商");
  const provider = ai.providers.find((item) => item.id === ai.activeProviderId);
  const providerOptions: Record<string, string> = {};
  for (const item of ai.providers) providerOptions[item.id] = item.name || "未命名供应商";
  selector.addDropdown((dropdown) => {
    if (!provider) dropdown.addOption("", "尚未配置供应商");
    dropdown.addOptions(providerOptions).setValue(ai.activeProviderId).setDisabled(!provider).onChange(async (value) => {
      ai.activeProviderId = value;
      await save();
      render();
    });
  }).addButton((button) => button.setButtonText("添加供应商").onClick(async () => {
    const added = createAIProvider();
    added.name = ai.providers.length ? `供应商 ${ai.providers.length + 1}` : "DeepSeek";
    ai.providers.push(added);
    ai.activeProviderId = added.id;
    await save();
    render();
  }));

  if (provider) {
    const card = container.createDiv({ cls: "ome-ai-card" });
    new Setting(card).setName("供应商名称").addText((text) => text
      .setPlaceholder("例如：DeepSeek").setValue(provider.name).onChange(async (value) => {
        provider.name = value;
        const option = Array.from(selector.controlEl.querySelectorAll("option")).find((item) => item.value === provider.id);
        if (option) option.textContent = value || "未命名供应商";
        await save();
      }));
    new Setting(card).setName("API 地址").setDesc("填写完整的 Chat Completions 地址。")
      .addText((text) => text.setPlaceholder("https://api.deepseek.com/chat/completions")
        .setValue(provider.endpoint).onChange(async (value) => { provider.endpoint = value; await save(); }));
    new Setting(card).setName("API Key").setDesc("保存在本库的插件 data.json 中；同步该文件时密钥也会同步。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text.inputEl.spellcheck = false;
        text.setPlaceholder("输入 API Key").setValue(provider.apiKey)
          .onChange(async (value) => { provider.apiKey = value; await save(); });
      });
    new Setting(card).setName("模型名称").setDesc("填写供应商支持的模型 ID，例如 deepseek-v4-flash 或 deepseek-v4-pro。")
      .addText((text) => text.setPlaceholder("deepseek-v4-flash").setValue(provider.model)
        .onChange(async (value) => { provider.model = value; await save(); }));
    new Setting(card).setName("思考参数格式").setDesc("不同接口的思考参数不同，请按供应商文档选择。")
      .addDropdown((dropdown) => dropdown
        .addOption("deepseek", "DeepSeek（thinking）")
        .addOption("reasoning-effort", "兼容接口（reasoning_effort）")
        .addOption("none", "不发送思考参数")
        .setValue(provider.thinkingFormat).onChange(async (value) => {
          provider.thinkingFormat = value as ThinkingFormat;
          await save();
          render();
        }));
    new Setting(card).setName("开启思考")
      .setDesc(provider.thinkingFormat === "none" ? "当前使用供应商默认行为。" : "关闭时会向接口明确发送关闭思考的参数。")
      .addToggle((toggle) => toggle.setValue(provider.thinkingEnabled).setDisabled(provider.thinkingFormat === "none")
        .onChange(async (value) => {
          provider.thinkingEnabled = value;
          await save();
          render();
        }));
    new Setting(card).setName("思考深度")
      .setDesc(provider.thinkingFormat === "deepseek"
        ? "DeepSeek 支持低、高、最高；中和极高会映射为高。关闭思考时不发送深度。"
        : "可用深度取决于模型；兼容接口关闭思考时发送 none。")
      .addDropdown((dropdown) => dropdown
        .addOptions({ low: "低 · low", medium: "中 · medium", high: "高 · high", xhigh: "极高 · xhigh", max: "最高 · max" })
        .setValue(provider.thinkingEffort).setDisabled(!provider.thinkingEnabled || provider.thinkingFormat === "none")
        .onChange(async (value) => { provider.thinkingEffort = value as ThinkingEffort; await save(); }));

    const actions = new Setting(card).setName("连接测试").setDesc("向当前供应商发送一句测试消息，会产生少量调用用量。");
    const status = card.createEl("p", { cls: "ome-ai-test-status", attr: { role: "status", "aria-live": "polite" } });
    actions.addButton((button) => button.setButtonText("测试连接").onClick(async () => {
      let request: ReturnType<typeof buildAIRequest>;
      try {
        request = buildAIRequest(provider, "Reply with OK only.");
      } catch (error) {
        status.setText(error instanceof Error ? error.message : "请检查配置。");
        status.dataset.state = "error";
        return;
      }
      button.setDisabled(true).setButtonText("测试中…");
      status.dataset.state = "pending";
      status.setText("正在测试当前配置，开启思考时可能需要稍等…");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          requestUrl({ ...request, throw: false }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("timeout")), 60000);
          }),
        ]);
        if (response.status < 200 || response.status >= 300) {
          const hints: Record<number, string> = {
            400: "请检查模型名称、思考参数和深度是否受支持。",
            401: "请检查 API Key。", 402: "请检查账户余额。", 403: "请检查密钥权限。",
            404: "请检查 API 地址和模型名称。", 422: "请检查模型支持的请求参数。",
            429: "请求过于频繁或额度不足，请稍后重试。",
          };
          status.dataset.state = "error";
          status.setText(`连接失败（HTTP ${response.status}）。${hints[response.status] ?? "请稍后重试或检查供应商服务状态。"}`);
        } else {
          const content = response.json?.choices?.[0]?.message?.content;
          const ok = typeof content === "string" && content.trim().length > 0;
          status.dataset.state = ok ? "success" : "error";
          status.setText(ok ? "连接成功，模型已返回回复。" : "接口已响应，但未返回有效的文本回复，请检查接口兼容性和模型配置。");
        }
      } catch (error) {
        status.dataset.state = "error";
        status.setText(error instanceof Error && error.message === "timeout"
          ? "等待回复超时，请稍后重试或降低思考深度。"
          : "测试失败，请检查网络、API 地址及接口返回格式。");
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        button.setDisabled(false).setButtonText("测试连接");
      }
    })).addButton((button) => button.setButtonText("删除供应商").setWarning().onClick(() => {
      new DeleteAIConfigModal(app, provider.name || "未命名供应商", async () => {
        ai.providers = ai.providers.filter((item) => item.id !== provider.id);
        ai.activeProviderId = ai.providers[0]?.id ?? "";
        await save();
        render();
      }).open();
    }));
  }

  container.createEl("h3", { text: "自定义提示词" });
  container.createEl("p", { cls: "setting-item-description", text: "在列表中管理提示词，点击“编辑”或“添加提示词”在独立窗口中修改。" });
  const editPrompt = (existing?: AIPrompt, copyFrom?: AIPrompt): void => {
    const initial = existing ?? (copyFrom
      ? { name: `${copyFrom.name || "提示词"}（副本）`, content: copyFrom.content }
      : { name: "", content: "" });
    new AIPromptModal(app, existing ? "编辑提示词" : "添加提示词", initial, async (draft) => {
      const previousPrompts = ai.prompts;
      const previousDefault = ai.defaultPromptId;
      if (existing) {
        ai.prompts = ai.prompts.map((prompt) => prompt.id === existing.id ? { ...prompt, ...draft } : prompt);
      } else {
        const prompt = { id: createAIId(), ...draft };
        ai.prompts = [...ai.prompts];
        const index = copyFrom ? ai.prompts.findIndex((item) => item.id === copyFrom.id) : -1;
        ai.prompts.splice(index >= 0 ? index + 1 : ai.prompts.length, 0, prompt);
        if (!ai.defaultPromptId) ai.defaultPromptId = prompt.id;
      }
      try {
        await save();
      } catch (error) {
        ai.prompts = previousPrompts;
        ai.defaultPromptId = previousDefault;
        throw error;
      }
      render();
    }).open();
  };
  const promptOptions: Record<string, string> = {};
  for (const prompt of ai.prompts) promptOptions[prompt.id] = prompt.name || "未命名提示词";
  new Setting(container).setName("默认提示词").addDropdown((dropdown) => {
    if (!ai.prompts.length) dropdown.addOption("", "尚未添加提示词");
    dropdown.addOptions(promptOptions).setValue(ai.defaultPromptId).setDisabled(!ai.prompts.length)
      .onChange(async (value) => { ai.defaultPromptId = value; await save(); render(); });
  }).addButton((button) => button.setButtonText("添加提示词").onClick(() => editPrompt()));
  if (!ai.prompts.length) container.createEl("p", { cls: "ome-ai-empty", text: "还没有提示词，点击“添加提示词”开始配置。" });
  const list = container.createDiv({ cls: "ome-ai-prompt-list", attr: { role: "list", "aria-label": "自定义提示词" } });
  for (const prompt of ai.prompts) {
    const row = list.createDiv({ cls: "ome-ai-prompt-row", attr: { role: "listitem" } });
    const preview = prompt.content.replace(/\s+/g, " ").trim();
    const setting = new Setting(row).setName(prompt.name || "未命名提示词")
      .setDesc(preview ? `${preview.slice(0, 120)}${preview.length > 120 ? "…" : ""}` : "尚未填写内容")
      .addButton((button) => button.setButtonText("编辑").onClick(() => editPrompt(prompt)))
      .addButton((button) => button.setButtonText("复制").onClick(() => editPrompt(undefined, prompt)))
      .addButton((button) => button.setButtonText("删除").setWarning().onClick(() => {
        new DeleteAIConfigModal(app, prompt.name || "未命名提示词", async () => {
          ai.prompts = ai.prompts.filter((item) => item.id !== prompt.id);
          if (ai.defaultPromptId === prompt.id) ai.defaultPromptId = ai.prompts[0]?.id ?? "";
          await save();
          render();
        }).open();
      }));
    if (prompt.id === ai.defaultPromptId) setting.nameEl.createSpan({ cls: "ome-ai-prompt-default", text: "默认" });
  }
}

class DeleteAIConfigModal extends Modal {
  constructor(app: App, private readonly name: string, private readonly onConfirm: () => Promise<void>) { super(app); }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: "删除配置？" });
    this.contentEl.createEl("p", { text: `确定删除“${this.name}”？此操作无法撤销。` });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("删除").setWarning().onClick(async () => {
        button.setDisabled(true);
        await this.onConfirm();
        this.close();
      }));
  }

  onClose(): void { this.contentEl.empty(); }
}
