import { App, Modal, Notice, Setting } from "obsidian";

export class AIResultModal extends Modal {
  private result = "";
  private status = "正在读取原文并生成，请稍候…";
  private isError = false;
  private opened = false;

  constructor(app: App, private readonly promptName: string, private readonly model: string) { super(app); }

  onOpen(): void {
    this.opened = true;
    this.modalEl.addClass("ome-ai-result-modal");
    this.render();
  }

  showResult(result: string): void {
    this.result = result;
    this.status = "生成完成";
    this.isError = false;
    if (this.opened) this.render();
  }

  showError(message: string): void {
    this.status = message;
    this.isError = true;
    if (this.opened) this.render();
    else new Notice(message);
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.promptName });
    this.contentEl.createEl("p", { cls: "setting-item-description", text: this.model });
    this.contentEl.createEl("p", {
      cls: `ome-ai-result-status${this.isError ? " is-error" : ""}`,
      text: this.status,
      attr: { role: "status", "aria-live": "polite" },
    });
    if (this.result) {
      const output = this.contentEl.createEl("textarea", {
        cls: "ome-ai-result-text", attr: { "aria-label": "AI 生成结果", readonly: "true" },
      });
      output.value = this.result;
    } else if (!this.isError) {
      this.contentEl.createEl("p", { cls: "setting-item-description", text: "关闭窗口后仍会继续生成，完成后正文会自动追加到当前高亮卡片。" });
    }
    const actions = new Setting(this.contentEl);
    if (this.result) actions.addButton((button) => button.setButtonText("复制正文").setCta().onClick(async () => {
      try {
        await navigator.clipboard.writeText(this.result);
        new Notice("已复制正文");
      } catch {
        new Notice("复制失败，请在正文框中全选并复制。");
      }
    }));
    actions.addButton((button) => button.setButtonText("关闭").onClick(() => this.close()));
  }

  onClose(): void { this.opened = false; this.contentEl.empty(); }
}
