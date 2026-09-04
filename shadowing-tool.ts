import { App, Modal, setIcon } from "obsidian";
import { SHADOWING_QR_IMAGE } from "./shadowing-qr";
import { MATERIALS_QR_IMAGE } from "./materials-qr";

interface QrCardOptions {
  title: string;
  description: string;
  image: string;
  alt: string;
  height: string;
}

export function renderShadowingToolCard(parent: HTMLElement, app: App): void {
  renderQrCard(parent, app, {
    title: "影子跟读工具",
    description: "逐句拆分，并生成高清语音。",
    image: SHADOWING_QR_IMAGE,
    alt: "影子跟读工具二维码，使用微信扫一扫打开小程序",
    height: "294",
  });
}

export function renderMaterialsCard(parent: HTMLElement, app: App): void {
  renderQrCard(parent, app, {
    title: "获取素材",
    description: "关注口语仓库，获取口语素材。",
    image: MATERIALS_QR_IMAGE,
    alt: "口语仓库公众号二维码，使用微信扫一扫关注",
    height: "258",
  });
}

function renderQrCard(parent: HTMLElement, app: App, options: QrCardOptions): void {
  const card = parent.createEl("button", {
    cls: "ome-stat-card ome-shadowing-card",
    attr: { type: "button", "aria-label": `${options.title}：查看二维码`, "aria-haspopup": "dialog" },
  });
  const icon = card.createSpan({ cls: "ome-stat-icon" });
  setIcon(icon, "qr-code");
  const copy = card.createSpan({ cls: "ome-shadowing-card-copy" });
  copy.createSpan({ cls: "ome-stat-value", text: options.title });
  copy.createSpan({ cls: "ome-stat-label", text: options.description });
  card.addEventListener("click", () => new QrCardModal(app, options).open());
}

class QrCardModal extends Modal {
  constructor(app: App, private readonly options: QrCardOptions) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("ome-shadowing-modal");
    this.contentEl.addClass("ome-shadowing-modal-content");
    this.contentEl.createEl("img", {
      cls: "ome-shadowing-qr",
      attr: { src: this.options.image, alt: this.options.alt, width: "258", height: this.options.height },
    });
    this.contentEl.createEl("h2", { text: this.options.title });
    this.contentEl.createEl("p", { cls: "setting-item-description", text: this.options.description });
  }

  onClose(): void { this.contentEl.empty(); }
}
