import { App, Modal, setIcon } from "obsidian";
import { SHADOWING_QR_IMAGE } from "./shadowing-qr";

export function renderShadowingToolCard(parent: HTMLElement, app: App): void {
  const card = parent.createEl("button", {
    cls: "ome-stat-card ome-shadowing-card",
    attr: { type: "button", "aria-label": "影子跟读工具：查看二维码", "aria-haspopup": "dialog" },
  });
  const icon = card.createSpan({ cls: "ome-stat-icon" });
  setIcon(icon, "qr-code");
  const copy = card.createSpan({ cls: "ome-shadowing-card-copy" });
  copy.createSpan({ cls: "ome-stat-value", text: "影子跟读工具" });
  copy.createSpan({ cls: "ome-stat-label", text: "逐句拆分，并生成高清语音。" });
  card.addEventListener("click", () => new ShadowingToolModal(app).open());
}

class ShadowingToolModal extends Modal {
  onOpen(): void {
    this.modalEl.addClass("ome-shadowing-modal");
    this.contentEl.addClass("ome-shadowing-modal-content");
    this.contentEl.createEl("img", {
      cls: "ome-shadowing-qr",
      attr: { src: SHADOWING_QR_IMAGE, alt: "影子跟读工具二维码，使用微信扫一扫打开小程序", width: "258", height: "294" },
    });
    this.contentEl.createEl("h2", { text: "影子跟读工具" });
    this.contentEl.createEl("p", { cls: "setting-item-description", text: "逐句拆分，并生成高清语音。" });
  }

  onClose(): void { this.contentEl.empty(); }
}
