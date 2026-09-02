import { App, Modal, Notice, Setting } from "obsidian";
import { AIPrompt } from "./ai";

export class AIPromptModal extends Modal {
  private name: string;
  private content: string;
  private saving = false;

  constructor(
    app: App,
    private readonly title: string,
    initial: Pick<AIPrompt, "name" | "content">,
    private readonly onSave: (draft: Pick<AIPrompt, "name" | "content">) => Promise<void>,
  ) {
    super(app);
    this.name = initial.name;
    this.content = initial.content;
  }

  onOpen(): void {
    this.modalEl.addClass("ome-ai-prompt-modal");
    this.contentEl.createEl("h2", { text: this.title });
    new Setting(this.contentEl).setClass("ome-ai-prompt-editor-name").setName("提示词名称")
      .addText((text) => text.setPlaceholder("例如：口语生成").setValue(this.name)
        .onChange((value) => { this.name = value; }));
    new Setting(this.contentEl).setClass("ome-ai-prompt-content").setName("提示词内容")
      .addTextArea((text) => {
        text.inputEl.rows = 14;
        text.inputEl.setAttribute("aria-label", "提示词内容");
        text.setPlaceholder("填写角色、任务、要求和输出格式…").setValue(this.content)
          .onChange((value) => { this.content = value; });
      });
    this.contentEl.createEl("p", {
      cls: "setting-item-description", text: "点击保存后生效；取消或关闭窗口将放弃本次修改。",
    });
    new Setting(this.contentEl).setClass("ome-ai-prompt-editor-actions")
      .addButton((button) => button.setButtonText("取消").onClick(() => {
        if (!this.saving) this.close();
      }))
      .addButton((button) => button.setButtonText("保存").setCta().onClick(async () => {
        if (this.saving) return;
        if (!this.name.trim()) { new Notice("请输入提示词名称。"); return; }
        if (!this.content.trim()) { new Notice("请输入提示词内容。"); return; }
        this.saving = true;
        button.setDisabled(true).setButtonText("保存中…");
        try {
          await this.onSave({ name: this.name.trim(), content: this.content });
          this.close();
        } catch {
          new Notice("保存失败，请重试。窗口中的内容已保留。");
        } finally {
          this.saving = false;
          button.setDisabled(false).setButtonText("保存");
        }
      }));
  }

  onClose(): void { this.contentEl.empty(); }
}
