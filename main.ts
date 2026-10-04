import {
  App,
  Editor,
  FuzzySuggestModal,
  ItemView,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  requestUrl,
  setIcon,
} from "obsidian";
import { AIPrompt, AIResult, AISettings, buildAINoteRequest, buildHighlightInput, getHighlightAIResults, normalizeAISettings, parseAIResponse, parseAINoteContent } from "./ai";
import { renderAISettings } from "./ai-settings";
import { AIResultModal } from "./ai-result-modal";
import { bracketToCheckbox } from "./bracket-to-checkbox";

const VIEW_TYPE = "one-minute-english-view";
const HIGHLIGHTS_VIEW_TYPE = "one-minute-english-highlights-view";
const GOAL_VIEW_TYPE = "one-minute-english-goal-view";
type MaterialStatus = "pending" | "mined" | "exhausted";

interface MaterialEntry {
  file: TFile;
  status: MaterialStatus;
  addedAt: number;
  minedAt: number;
  rounds: number;
  seedCount: number;
}

/** 卡片摘要的最大字符数。 */
const PREVIEW_LIMIT = 220;

/** 待淘素材入库超过这个天数，卡片上就标为「等太久了」。 */
const AGE_STALE_DAYS = 14;

function stripToPreview(raw: string, limit = PREVIEW_LIMIT): string {
  let text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/<\/?mark\b[^>]*>/gi, "");
  text = text.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/[*_~`]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function appendLinkAtBottom(content: string, link: string): string {
  if (content.split(/\r?\n/).some((line) => line.trim() === link)) return content;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const separator = !content
    ? ""
    : content.endsWith(`${eol}${eol}`)
      ? ""
      : content.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${content}${separator}${link}${eol}`;
}

interface HighlightNote {
  id: string;
  text: string;
  note: string;
  sourcePath: string;
  createdAt: number;
  aiResult?: AIResult;
  aiResults?: AIResult[];
  aiNotes?: { path: string; promptName: string; createdAt: number }[];
}

interface FolderTab {
  id: string;
  name: string;
  path: string;
}

/** 目标进度面板配置。 */
interface GoalSettings {
  /** 目标数量：希望完成多少篇笔记。 */
  count: number;
  /** 目标目录：统计哪个目录下的笔记。 */
  folder: string;
  /** 截止日期，格式 YYYY-MM-DD；留空表示不设期限。 */
  deadline: string;
  /** 判断完成的属性名。 */
  property: string;
  /** 判断完成的属性值。 */
  value: string;
  /** 目标描述：多行文字，说明这个目标想达成什么。 */
  description: string;
}

interface OneMinuteEnglishSettings {
  openAsStartupPage: boolean;
  materialFolder: string;
  topicFolder: string;
  statusProperty: string;
  completedValue: string;
  quickCaptureFolder: string;
  quickCaptureFilenameFormat: string;
  speechFolder: string;
  customTabs: FolderTab[];
  highlights: HighlightNote[];
  ai: AISettings;
  materialStatusProperty: string;
  pendingValue: string;
  minedValue: string;
  exhaustedValue: string;
  minedAtProperty: string;
  mineRoundProperty: string;
  bracketToCheckbox: boolean;
  goal: GoalSettings;
}

const DEFAULT_SETTINGS: OneMinuteEnglishSettings = {
  openAsStartupPage: false,
  materialFolder: "",
  topicFolder: "",
  statusProperty: "",
  completedValue: "已完成",
  quickCaptureFolder: "",
  quickCaptureFilenameFormat: "",
  speechFolder: "",
  customTabs: [],
  highlights: [],
  ai: { providers: [], activeProviderId: "", prompts: [], defaultPromptId: "" },
  materialStatusProperty: "素材状态",
  pendingValue: "待淘",
  minedValue: "已淘",
  exhaustedValue: "淘干",
  minedAtProperty: "上次淘的时间",
  mineRoundProperty: "淘过轮次",
  bracketToCheckbox: false,
  goal: {
    count: 30,
    folder: "",
    deadline: "",
    property: "状态",
    value: "已完成",
    description: "",
  },
};

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private readonly onChoose: (folder: TFolder) => void) {
    super(app);
    this.setPlaceholder("选择库内文件夹…");
  }

  getItems(): TFolder[] {
    const folders: TFolder[] = [];
    const visit = (item: TAbstractFile): void => {
      if (item instanceof TFolder) {
        if (item.path !== "/") folders.push(item);
        item.children.forEach(visit);
      }
    };
    visit(this.app.vault.getRoot());
    return folders;
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}

class QuickCaptureModal extends Modal {
  private text = "";

  constructor(app: App, private readonly onSave: (content: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("ome-capture-modal-shell");
    contentEl.addClass("ome-capture-modal");
    contentEl.createEl("h2", { text: "快速记录" });
    contentEl.createEl("p", { cls: "ome-capture-description", text: "输入内容后保存为新的 Markdown 文档。" });
    const textarea = contentEl.createEl("textarea", {
      cls: "ome-capture-textarea",
      attr: { placeholder: "在这里输入内容…", "aria-label": "快速记录内容" },
    });
    textarea.addEventListener("input", () => { this.text = textarea.value; });
    const actions = contentEl.createDiv({ cls: "ome-capture-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    save.addEventListener("click", () => void this.save());
    textarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void this.save();
      }
    });
    window.setTimeout(() => textarea.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async save(): Promise<void> {
    if (!this.text.trim()) {
      new Notice("请输入要保存的内容");
      return;
    }
    await this.onSave(this.text);
    this.close();
  }
}

class HighlightToNoteModal extends Modal {
  private noteName: string;

  constructor(
    app: App,
    defaultName: string,
    private readonly onSave: (name: string) => Promise<boolean>,
  ) {
    super(app);
    this.noteName = defaultName;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("ome-highlight-note-modal");
    contentEl.createEl("h2", { text: "将高亮转为笔记" });
    contentEl.createEl("p", { cls: "ome-capture-description", text: "设置笔记名称，笔记将保存到“话题目录”。" });
    const input = contentEl.createEl("input", {
      type: "text",
      value: this.noteName,
      attr: { placeholder: "输入笔记名称", "aria-label": "笔记名称" },
    });
    input.addEventListener("input", () => { this.noteName = input.value; });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.save();
      }
    });

    const actions = contentEl.createDiv({ cls: "ome-capture-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    save.addEventListener("click", () => void this.save());
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async save(): Promise<void> {
    if (!this.noteName.trim()) {
      new Notice("请输入笔记名称");
      return;
    }
    if (await this.onSave(this.noteName)) this.close();
  }
}

class DeleteHighlightModal extends Modal {
  constructor(
    app: App,
    private readonly highlight: HighlightNote,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("ome-delete-highlight-modal");
    contentEl.createEl("h2", { text: "删除高亮？" });
    contentEl.createEl("p", { text: "右侧高亮卡片和补充内容将被删除，原笔记中的文字会保留并取消高亮。" });
    contentEl.createDiv({ cls: "ome-delete-highlight-preview", text: this.highlight.text });
    const actions = contentEl.createDiv({ cls: "ome-capture-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-warning", text: "删除" });
    confirm.addEventListener("click", () => void this.confirm());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async confirm(): Promise<void> {
    await this.onConfirm();
    this.close();
  }
}

export default class OneMinuteEnglishPlugin extends Plugin {
  settings: OneMinuteEnglishSettings = DEFAULT_SETTINGS;
  private isOpeningStartupPage = false;
  private selectionButton: HTMLButtonElement | null = null;
  private readonly pendingAI = new Map<string, AIResultModal>();
  private queueBar: HTMLElement | null = null;
  private queueBarToggle: HTMLButtonElement | null = null;
  private queueBarComplete: HTMLButtonElement | null = null;
  private queueBarCompanion: HTMLButtonElement | null = null;
  private queueBarObserver: ResizeObserver | null = null;
  private queueBarObserved: HTMLElement | null = null;
  private queueBarFrame = 0;
  private readonly previewCache = new Map<string, { mtime: number; text: string }>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new OneMinuteEnglishView(leaf, this));
    this.registerView(HIGHLIGHTS_VIEW_TYPE, (leaf) => new HighlightsView(leaf, this));
    this.registerView(GOAL_VIEW_TYPE, (leaf) => new GoalView(leaf, this));
    this.registerEditorExtension(bracketToCheckbox(() => this.settings.bracketToCheckbox));
    this.addRibbonIcon("languages", "打开 One Minute English", () => void this.activateView());
    this.addRibbonIcon("highlighter", "打开高亮侧栏", () => void this.activateHighlightsView());
    this.addRibbonIcon("target", "打开目标进度面板", () => void this.activateGoalView());
    this.addCommand({ id: "open-one-minute-english", name: "打开主页", callback: () => void this.activateView() });
    this.addCommand({
      id: "highlight-selected-text",
      name: "将选中内容加入高亮",
      editorCheckCallback: (checking, editor, view) => {
        const hasSelection = Boolean(editor.getSelection().trim());
        if (!checking && hasSelection) void this.createHighlight(editor, view);
        return hasSelection;
      },
    });
    this.addCommand({ id: "open-highlights-sidebar", name: "打开高亮侧栏", callback: () => void this.activateHighlightsView() });
    this.addCommand({ id: "open-goal-panel", name: "打开目标进度面板", callback: () => void this.activateGoalView() });
    this.addCommand({
      id: "toggle-material-queue",
      name: "移出 / 回归淘金队列",
      checkCallback: (checking) => {
        const available = Boolean(this.activeMaterialFile());
        if (!checking && available) void this.toggleQueueMembership();
        return available;
      },
    });
    this.addCommand({ id: "open-next-material", name: "打开队列中的下一篇素材", callback: () => void this.openNextMaterial() });
    this.addCommand({
      id: "mark-material-mined",
      name: "把当前素材标记为已淘",
      checkCallback: (checking) => {
        const file = this.activeMaterialFile();
        if (!checking && file) void this.setMaterialStatus(file, "mined").then(() => this.updateQueueBar());
        return Boolean(file);
      },
    });
    this.registerDomEvent(document, "mouseup", (event) => {
      if (this.selectionButton?.contains(event.target as Node)) return;
      window.setTimeout(() => this.updateSelectionButton(), 0);
    });
    this.registerDomEvent(document, "keyup", () => window.setTimeout(() => this.updateSelectionButton(), 0));
    this.registerDomEvent(document, "mousedown", (event) => {
      if (!this.selectionButton?.contains(event.target as Node)) this.hideSelectionButton();
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.hideSelectionButton();
      this.updateQueueBar();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateQueueBar()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.updateQueueBar()));
    this.registerEvent(this.app.vault.on("create", () => this.updateQueueBar()));
    this.registerDomEvent(window, "resize", () => this.updateQueueBar());
    this.patchOpenLinkText();
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.updateHighlightPaths(file.path, oldPath)));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      void this.removeAINoteLinks(file.path, file instanceof TFolder)
        .catch(() => new Notice("失效链接已从卡片移除，但保存失败，请检查库是否可写。"));
    }));
    this.addSettingTab(new OneMinuteEnglishSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openAsStartupPage) void this.activateView();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => void this.openInEmptyLeaf()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updateQueueBar()));
    this.app.workspace.onLayoutReady(() => this.updateQueueBar());
  }

  onunload(): void {
    this.hideSelectionButton();
    this.queueBarObserver?.disconnect();
    this.queueBarObserver = null;
    this.queueBarObserved = null;
    cancelAnimationFrame(this.queueBarFrame);
    this.queueBar?.remove();
    this.queueBar = null;
    this.queueBarToggle = null;
    this.queueBarComplete = null;
  }

  async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async activateHighlightsView(): Promise<void> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(HIGHLIGHTS_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("无法打开右侧高亮栏");
        return;
      }
      await leaf.setViewState({ type: HIGHLIGHTS_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async activateGoalView(): Promise<void> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(GOAL_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("无法打开右侧目标面板");
        return;
      }
      await leaf.setViewState({ type: GOAL_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  private async createHighlight(editor: Editor, view: MarkdownView | MarkdownFileInfo): Promise<void> {
    const selection = editor.getSelection();
    this.hideSelectionButton();
    if (!selection.trim()) {
      new Notice("请先选中要高亮的内容");
      return;
    }
    if (!view.file) {
      new Notice("当前编辑器没有对应的笔记文件");
      return;
    }
    if (/<mark\b[^>]*data-ome-highlight-id=/i.test(selection)) {
      new Notice("选中内容里已经包含高亮");
      return;
    }

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    editor.replaceSelection(`<mark class="ome-note-highlight" data-ome-highlight-id="${id}">${selection}</mark>`);
    this.settings.highlights.unshift({
      id,
      text: selection,
      note: "",
      sourcePath: view.file.path,
      createdAt: Date.now(),
    });
    await this.saveSettings();
    await this.activateHighlightsView();
    new Notice("已加入高亮");
  }

  async convertHighlightToNote(highlight: HighlightNote): Promise<void> {
    const folder = this.settings.topicFolder.replace(/^\/+|\/+$/g, "");
    if (!folder) {
      new Notice("请先在 One Minute English 设置中配置“话题目录”");
      return;
    }
    const targetFolder = this.app.vault.getAbstractFileByPath(folder);
    if (!(targetFolder instanceof TFolder)) {
      new Notice("配置的“话题目录”不存在，请重新设置");
      return;
    }
    new HighlightToNoteModal(
      this.app,
      String(Date.now()),
      (name) => this.saveHighlightAsNote(highlight, folder, name),
    ).open();
  }

  showHighlightAIMenu(highlight: HighlightNote, button: HTMLElement): void {
    const menu = new Menu();
    const pending = this.pendingAI.get(highlight.id);
    if (pending) menu.addItem((item) => item.setTitle("正在生成，查看进度…").setIcon("loader")
      .onClick(() => pending.open()));
    const latestNote = highlight.aiNotes?.[highlight.aiNotes.length - 1];
    if (latestNote) menu.addItem((item) => item.setTitle("打开上次生成的笔记").setIcon("file-text")
      .onClick(() => void this.openAINote(latestNote.path)));
    const legacyResults = getHighlightAIResults(highlight);
    legacyResults.forEach((result, index) => menu.addItem((item) => item
      .setTitle(`历史结果 ${index + 1} · ${result.promptName || "AI 生成"}`).setIcon("history").onClick(() => {
        const modal = new AIResultModal(this.app, result.promptName, result.model);
        modal.showResult(result.content);
        modal.open();
      })));
    if (pending || latestNote || legacyResults.length) menu.addSeparator();
    const prompts = this.settings.ai.prompts;
    if (!prompts.length) menu.addItem((item) => item.setTitle("请先在设置 → AI 中添加提示词").setDisabled(true));
    for (const prompt of prompts) {
      menu.addItem((item) => item.setTitle(prompt.name || "未命名提示词")
        .setIcon(prompt.id === this.settings.ai.defaultPromptId ? "star" : "sparkles")
        .setDisabled(Boolean(pending))
        .onClick(() => void this.generateHighlightAI(highlight, prompt)));
    }
    const rect = button.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom }, button.ownerDocument);
  }

  isHighlightAIPending(id: string): boolean {
    return this.pendingAI.has(id);
  }

  private refreshHighlightAIState(id: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(HIGHLIGHTS_VIEW_TYPE)) {
      if (leaf.view instanceof HighlightsView) leaf.view.refreshAIState(id);
    }
  }

  private async generateHighlightAI(highlight: HighlightNote, selectedPrompt: AIPrompt): Promise<void> {
    if (this.pendingAI.has(highlight.id)) return;
    const folderPath = this.settings.topicFolder.trim().replace(/^\/+|\/+$/g, "");
    if (!folderPath) { new Notice("请先在设置 → 常规中配置“话题目录”。"); return; }
    const topicFolder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
    if (!(topicFolder instanceof TFolder)) { new Notice("配置的“话题目录”不存在，请在设置 → 常规中重新选择。"); return; }
    const configured = this.settings.ai.providers.find((provider) => provider.id === this.settings.ai.activeProviderId);
    if (!configured) { new Notice("请先在设置 → AI 中配置并选择供应商。"); return; }
    if (!selectedPrompt.content.trim()) { new Notice("这个提示词内容为空，请先在设置 → AI 中填写。"); return; }
    const provider = { ...configured };
    const prompt = { ...selectedPrompt };
    // Capture the card at selection time; later edits must not change an in-flight request.
    const snapshot = { ...highlight };
    const modal = new AIResultModal(this.app, prompt.name || "AI 生成", `${provider.name} · ${provider.model}`);
    this.pendingAI.set(highlight.id, modal);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      this.refreshHighlightAIState(highlight.id);
      modal.open();
      const file = this.app.vault.getAbstractFileByPath(snapshot.sourcePath);
      if (!(file instanceof TFile)) throw new Error("找不到这条高亮的原笔记，请检查文件是否已被删除或移动。");
      const openEditor = this.app.workspace.getLeavesOfType("markdown")
        .map((leaf) => leaf.view)
        .find((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === "source");
      const source = openEditor ? openEditor.editor.getValue() : await this.app.vault.read(file);
      const request = buildAINoteRequest(provider, buildHighlightInput(source, snapshot), prompt);
      const response = await Promise.race([
        requestUrl({ ...request, throw: false }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("生成等待超时，请稍后重试或降低思考深度。")), 180000);
        }),
      ]);
      let data: unknown;
      try { data = JSON.parse(response.text); } catch { data = undefined; }
      const result = parseAIResponse(response.status, data);
      modal.showResult(result);
      const generated = parseAINoteContent(result);
      modal.showResult(generated.content);
      const current = this.settings.highlights.find((item) => item.id === snapshot.id);
      if (current) {
        let createdNote: TFile | undefined;
        let clearedSupplement = false;
        try {
          createdNote = await this.createAIResultNote(topicFolder, file, generated.title, generated.content, snapshot);
          current.aiNotes = [...(current.aiNotes ?? []), { path: createdNote.path, promptName: prompt.name, createdAt: Date.now() }];
          if (current.note === snapshot.note && current.note !== "") {
            current.note = "";
            clearedSupplement = true;
            this.refreshHighlightSupplement(current);
          }
          for (const leaf of this.app.workspace.getLeavesOfType(HIGHLIGHTS_VIEW_TYPE)) {
            if (leaf.view instanceof HighlightsView) leaf.view.refreshAIResults(current);
          }
          await this.saveSettings(false);
          modal.close();
          new Notice(`已生成话题笔记：${createdNote.basename}`);
        } catch {
          if (clearedSupplement && current.note === "") {
            current.note = snapshot.note;
            this.refreshHighlightSupplement(current);
          }
          modal.showError(createdNote
            ? `笔记已保存到 ${createdNote.path}，但卡片链接保存失败，可在话题目录中打开笔记。`
            : "正文已生成，但新笔记创建失败。请检查话题目录和原笔记是否仍存在，并先复制正文。");
          modal.open();
        }
      } else {
        modal.showError("正文已生成，但原高亮已删除，请从此窗口复制正文。");
      }
    } catch (error) {
      // Avoid exposing response bodies or credentials in notices.
      const message = error instanceof Error ? error.message : "";
      const safePrefixes = ["找不到这条", "请输入", "API 地址", "请先填写", "请求失败", "接口未", "模型未", "回复达到", "生成等待", "AI 返回"];
      modal.showError(safePrefixes.some((prefix) => message.startsWith(prefix)) ? message : "生成失败，请检查网络、API 地址及供应商服务状态。");
      if (message.startsWith("AI 返回")) modal.open();
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.pendingAI.delete(highlight.id);
      this.refreshHighlightAIState(highlight.id);
    }
  }

  private refreshHighlightSupplement(highlight: HighlightNote): void {
    for (const leaf of this.app.workspace.getLeavesOfType(HIGHLIGHTS_VIEW_TYPE)) {
      if (leaf.view instanceof HighlightsView) leaf.view.refreshSupplement(highlight);
    }
  }

  private async createAIResultNote(folder: TFolder, source: TFile, title: string, result: string, highlight: Pick<HighlightNote, "text" | "note">): Promise<TFile> {
    if (this.app.vault.getAbstractFileByPath(folder.path) !== folder || this.app.vault.getAbstractFileByPath(source.path) !== source) {
      throw new Error("The topic folder or source note no longer exists.");
    }
    let filename = title;
    let collisionTimestamp = 0;
    for (let suffix = 0; ; suffix++) {
      const path = normalizePath(`${folder.path}/${filename}.md`);
      const statusProperty = this.settings.statusProperty.trim() || "状态";
      const sourceLink = this.app.fileManager.generateMarkdownLink(source, path);
      const supplement = highlight.note.trim() ? highlight.note : "（未填写）";
      const content = `---\n${JSON.stringify(statusProperty)}: []\n---\n\n${result}\n\n## 高亮内容\n\n${highlight.text}\n\n## 补充内容\n\n${supplement}\n\n## 来源笔记\n\n${sourceLink}\n`;
      try {
        return await this.app.vault.create(path, content);
      } catch (error) {
        // Try the AI title first. Only check this exact path after create fails.
        if (!this.app.vault.getAbstractFileByPath(path)) throw error;
        if (!collisionTimestamp) collisionTimestamp = Date.now();
        filename = `${title}-${collisionTimestamp}${suffix ? `-${suffix}` : ""}`;
      }
    }
  }

  async openAINote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      try {
        await this.removeAINoteLinks(path);
        new Notice("关联笔记已不存在，已清理卡片中的失效链接。");
      } catch {
        new Notice("失效链接已从卡片移除，但保存失败，请检查库是否可写。");
      }
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  private async removeAINoteLinks(path: string, includeDescendants = false): Promise<void> {
    const changed: HighlightNote[] = [];
    for (const highlight of this.settings.highlights) {
      if (!highlight.aiNotes?.length) continue;
      const remaining = highlight.aiNotes.filter((note) => note.path !== path
        && !(includeDescendants && note.path.startsWith(`${path}/`)));
      if (remaining.length === highlight.aiNotes.length) continue;
      highlight.aiNotes = remaining;
      changed.push(highlight);
    }
    if (!changed.length) return;
    for (const leaf of this.app.workspace.getLeavesOfType(HIGHLIGHTS_VIEW_TYPE)) {
      if (leaf.view instanceof HighlightsView) {
        for (const highlight of changed) leaf.view.refreshAIResults(highlight);
      }
    }
    await this.saveSettings(false);
  }

  requestDeleteHighlight(highlight: HighlightNote): void {
    new DeleteHighlightModal(this.app, highlight, () => this.deleteHighlight(highlight)).open();
  }

  private async deleteHighlight(highlight: HighlightNote): Promise<void> {
    const source = this.app.vault.getAbstractFileByPath(highlight.sourcePath);
    if (source instanceof TFile) {
      const openingTag = `<mark class="ome-note-highlight" data-ome-highlight-id="${highlight.id}">`;
      await this.app.vault.process(source, (content) => {
        const start = content.indexOf(openingTag);
        if (start < 0) return content;
        const textStart = start + openingTag.length;
        const end = content.indexOf("</mark>", textStart);
        if (end < 0) return content;
        return `${content.slice(0, start)}${content.slice(textStart, end)}${content.slice(end + "</mark>".length)}`;
      });
    }
    this.settings.highlights = this.settings.highlights.filter((item) => item.id !== highlight.id);
    await this.saveSettings();
    new Notice("已删除高亮，原文字内容已保留");
  }

  private async saveHighlightAsNote(highlight: HighlightNote, folder: string, name: string): Promise<boolean> {
    const safeName = name.replace(/\.md$/i, "").replace(/[\\/:*?"<>|]/g, "-").trim();
    if (!safeName) {
      new Notice("请输入有效的笔记名称");
      return false;
    }
    const path = normalizePath(`${folder}/${safeName}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice("同名笔记已经存在，请修改名称");
      return false;
    }
    const source = this.app.vault.getAbstractFileByPath(highlight.sourcePath);
    if (!(source instanceof TFile)) {
      new Notice("原笔记已不存在，无法建立双链");
      return false;
    }
    const note = highlight.note.trim();
    const statusProperty = this.settings.statusProperty.trim() || "状态";
    const frontmatter = `---\n${JSON.stringify(statusProperty)}: []\n---`;
    const noteBody = note ? `${highlight.text}\n\n## 补充内容\n\n${note}` : highlight.text;
    const body = `${frontmatter}\n\n${noteBody}`;
    const sourceLink = this.app.fileManager.generateMarkdownLink(source, path);
    const content = appendLinkAtBottom(body, sourceLink);
    const file = await this.app.vault.create(path, content);
    const newNoteLink = this.app.fileManager.generateMarkdownLink(file, source.path);
    await this.app.vault.process(source, (sourceContent) => appendLinkAtBottom(sourceContent, newNoteLink));
    new Notice(`已生成笔记：${file.basename}`);
    await this.app.workspace.getLeaf(false).openFile(file);
    return true;
  }

  private updateSelectionButton(): void {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = window.getSelection();
    const anchor = selection?.anchorNode instanceof Element
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    if (!markdownView || !selection || selection.isCollapsed || !anchor || !anchor.closest(".markdown-source-view")) {
      this.hideSelectionButton();
      return;
    }
    if (!markdownView.containerEl.contains(anchor) || !markdownView.editor.getSelection().trim()) {
      this.hideSelectionButton();
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      this.hideSelectionButton();
      return;
    }

    const button = this.selectionButton ?? this.createSelectionButton();
    button.style.visibility = "hidden";
    button.style.display = "flex";
    const width = button.offsetWidth;
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2));
    button.style.left = `${left}px`;
    button.style.top = `${Math.max(8, rect.top - button.offsetHeight - 8)}px`;
    button.style.visibility = "visible";
    this.queueBar?.addClass("is-dimmed");
  }

  private createSelectionButton(): HTMLButtonElement {
    const button = document.body.createEl("button", { cls: "ome-selection-highlight-button", text: "加入高亮" });
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (markdownView) void this.createHighlight(markdownView.editor, markdownView);
    });
    this.selectionButton = button;
    return button;
  }

  private hideSelectionButton(): void {
    this.selectionButton?.remove();
    this.selectionButton = null;
    this.queueBar?.removeClass("is-dimmed");
  }

  filesInFolder(folderPath: string): TFile[] {
    if (!folderPath) return [];
    const normalized = folderPath.replace(/^\/+|\/+$/g, "");
    return this.app.vault.getMarkdownFiles().filter((file) => file.path === normalized || file.path.startsWith(`${normalized}/`));
  }

  isMaterialFile(file: TFile): boolean {
    return this.isMaterialPath(file.path);
  }

  /** 素材目录判断（路径版），供链接跳转拦截等没有 TFile 对象的场景使用。 */
  isMaterialPath(path: string): boolean {
    const folder = this.settings.materialFolder.trim().replace(/^\/+|\/+$/g, "");
    if (!folder) return false;
    return path.startsWith(`${folder}/`);
  }

  statusPropertyName(): string {
    return this.settings.materialStatusProperty.trim() || "素材状态";
  }

  statusLabel(status: MaterialStatus): string {
    if (status === "mined") return this.settings.minedValue.trim() || "已淘";
    if (status === "exhausted") return this.settings.exhaustedValue.trim() || "淘干";
    return this.settings.pendingValue.trim() || "待淘";
  }

  frontmatterText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (Array.isArray(value)) return value.length ? this.frontmatterText(value[0]) : "";
    return String(value).trim();
  }

  readMaterial(file: TFile): MaterialEntry {
    const settings = this.settings;
    const frontmatter = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
    const rawStatus = this.frontmatterText(frontmatter[this.statusPropertyName()]).toLocaleLowerCase();
    const minedValue = (settings.minedValue.trim() || "已淘").toLocaleLowerCase();
    const exhaustedValue = (settings.exhaustedValue.trim() || "淘干").toLocaleLowerCase();
    const status: MaterialStatus = rawStatus === minedValue
      ? "mined"
      : rawStatus === exhaustedValue
        ? "exhausted"
        : "pending";
    const minedAt = Date.parse(this.frontmatterText(frontmatter[settings.minedAtProperty.trim() || "上次淘的时间"]));
    const rounds = Number.parseInt(this.frontmatterText(frontmatter[settings.mineRoundProperty.trim() || "淘过轮次"]), 10);
    return {
      file,
      status,
      addedAt: file.stat.ctime,
      minedAt: Number.isNaN(minedAt) ? file.stat.ctime : minedAt,
      rounds: Number.isNaN(rounds) ? 0 : Math.max(0, rounds),
      seedCount: settings.highlights.filter((highlight) => highlight.sourcePath === file.path).length,
    };
  }

  materials(): MaterialEntry[] {
    return this.filesInFolder(this.settings.materialFolder).map((file) => this.readMaterial(file));
  }

  sortMaterials(entries: MaterialEntry[]): MaterialEntry[] {
    const order: Record<MaterialStatus, number> = { pending: 0, mined: 1, exhausted: 2 };
    return [...entries].sort((a, b) => {
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      // 待淘：新收的排前面（今天的印象最深，先处理）
      // 已淘：最久没碰的排前面，让老素材在轮转里自己浮上来
      return a.status === "pending" ? b.addedAt - a.addedAt : a.minedAt - b.minedAt;
    });
  }

  queueEntries(): MaterialEntry[] {
    return this.sortMaterials(this.materials().filter((entry) => entry.status !== "exhausted"));
  }

  /** 目标目录下的笔记及其完成状态；未完成的排前面，组内按最近改动优先。 */
  goalEntries(): { file: TFile; done: boolean }[] {
    const goal = this.settings.goal;
    const property = (goal.property || "").trim();
    const value = (goal.value || "").trim().toLocaleLowerCase();
    return this.filesInFolder(goal.folder)
      .map((file) => {
        let done = false;
        if (property) {
          const frontmatter = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
          const raw = frontmatter[property];
          if (value) {
            const candidates = Array.isArray(raw) ? raw : [raw];
            done = candidates.some((item) => this.frontmatterText(item).toLocaleLowerCase() === value);
          } else {
            done = raw !== undefined && raw !== null;
          }
        }
        return { file, done };
      })
      .sort((a, b) => (a.done === b.done ? b.file.stat.mtime - a.file.stat.mtime : a.done ? 1 : -1));
  }

  /** 目标进度统计：已完成、剩余、进度比例、剩余天数。 */
  goalProgress(): {
    total: number;
    target: number;
    completed: number;
    remaining: number;
    ratio: number;
    daysLeft: number | null;
    expired: boolean;
    hasDeadline: boolean;
  } {
    const goal = this.settings.goal;
    const entries = goal.folder.trim() ? this.goalEntries() : [];
    const completed = entries.filter((entry) => entry.done).length;
    const target = Math.max(0, Math.floor(goal.count) || 0);
    const ratio = target > 0 ? Math.min(1, completed / target) : 0;
    const remaining = Math.max(0, target - completed);
    let daysLeft: number | null = null;
    let expired = false;
    const deadline = Date.parse(goal.deadline);
    if (!Number.isNaN(deadline)) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const end = new Date(deadline);
      end.setHours(0, 0, 0, 0);
      daysLeft = Math.round((end.getTime() - today.getTime()) / 86_400_000);
      expired = daysLeft < 0;
    }
    return {
      total: entries.length,
      target,
      completed,
      remaining,
      ratio,
      daysLeft,
      expired,
      hasDeadline: !Number.isNaN(deadline),
    };
  }

  async setMaterialStatus(file: TFile, status: MaterialStatus): Promise<void> {
    const settings = this.settings;
    const minedAtProperty = settings.minedAtProperty.trim() || "上次淘的时间";
    const roundProperty = settings.mineRoundProperty.trim() || "淘过轮次";
    const previous = this.readMaterial(file);
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const target = frontmatter as unknown as Record<string, unknown>;
      target[this.statusPropertyName()] = this.statusLabel(status);
      if (status === "mined") {
        target[minedAtProperty] = this.formatDate(new Date(), "YYYY-MM-DD");
        target[roundProperty] = previous.rounds + 1;
      }
    });
    if (status === "mined") {
      new Notice(`已标记：${file.basename}（第 ${previous.rounds + 1} 轮）`);
    } else if (status === "exhausted") {
      new Notice(`已移出队列：${file.basename}`);
    } else {
      new Notice(`已回归队列：${file.basename}`);
    }
  }

  formatDate(date: Date, format: string): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    const values: Record<string, string> = {
      YYYY: String(date.getFullYear()),
      YY: String(date.getFullYear()).slice(-2),
      MM: pad(date.getMonth() + 1),
      M: String(date.getMonth() + 1),
      dd: pad(date.getDate()),
      DD: pad(date.getDate()),
      d: String(date.getDate()),
      D: String(date.getDate()),
      HH: pad(date.getHours()),
      H: String(date.getHours()),
      mm: pad(date.getMinutes()),
      m: String(date.getMinutes()),
      ss: pad(date.getSeconds()),
      s: String(date.getSeconds()),
    };
    return format.replace(/YYYY|YY|MM|M|dd|DD|d|D|HH|H|mm|m|ss|s/g, (token) => values[token]);
  }

  dateText(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number): string => String(value).padStart(2, "0");
    if (date.getFullYear() === new Date().getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** 入库距今的自然日差（不看具体时刻，只算跨了几天）。 */
  addedDaysAgo(timestamp: number): number {
    const then = new Date(timestamp);
    then.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((today.getTime() - then.getTime()) / 86_400_000));
  }

  /** 待淘卡片上的入库年龄文案，附带是否已经「等太久」。 */
  addedAgeText(timestamp: number): { text: string; days: number; stale: boolean } {
    const days = this.addedDaysAgo(timestamp);
    const text = days === 0 ? "今天入库" : days === 1 ? "昨天入库" : `入库 ${days} 天前`;
    return { text, days, stale: days >= AGE_STALE_DAYS };
  }

  async previewText(file: TFile): Promise<string> {
    const full = await this.previewFullText(file);
    return full.length > PREVIEW_LIMIT ? `${full.slice(0, PREVIEW_LIMIT)}…` : full;
  }

  /** 去掉 Markdown 噪音后的全文（不截断），按文件 mtime 缓存。 */
  private async previewFullText(file: TFile): Promise<string> {
    const cached = this.previewCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.text;
    let raw = "";
    try {
      raw = await this.app.vault.cachedRead(file);
    } catch {
      raw = "";
    }
    const text = stripToPreview(raw, Number.MAX_SAFE_INTEGER);
    this.previewCache.set(file.path, { mtime: file.stat.mtime, text });
    return text;
  }

  private activeMaterialFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? null;
    return file && this.isMaterialFile(file) ? file : null;
  }

  private createQueueBar(): HTMLElement {
    const bar = document.body.createDiv({ cls: "ome-queue-bar is-hidden" });
    const toggle = bar.createEl("button", { cls: "ome-queue-bar-button", text: "移出队列" });
    toggle.addEventListener("mousedown", (event) => event.preventDefault());
    toggle.addEventListener("click", () => void this.toggleQueueMembership());
    const next = bar.createEl("button", { cls: "ome-queue-bar-button", text: "下一篇" });
    next.addEventListener("mousedown", (event) => event.preventDefault());
    next.addEventListener("click", () => void this.openNextMaterial());
    const complete = bar.createEl("button", { cls: "ome-queue-bar-button is-primary", text: "已阅" });
    complete.addEventListener("mousedown", (event) => event.preventDefault());
    complete.addEventListener("click", () => void this.completeMinedAndAdvance());
    const companion = bar.createEl("button", { cls: "ome-queue-bar-button", text: "新建笔记" });
    companion.addEventListener("mousedown", (event) => event.preventDefault());
    companion.addEventListener("click", () => void this.createCompanionNote());
    this.queueBar = bar;
    this.queueBarToggle = toggle;
    this.queueBarComplete = complete;
    this.queueBarCompanion = companion;
    return bar;
  }

  private observeQueueBarContainer(el: HTMLElement): void {
    if (this.queueBarObserved === el) return;
    if (!this.queueBarObserver) {
      this.queueBarObserver = new ResizeObserver(() => {
        cancelAnimationFrame(this.queueBarFrame);
        this.queueBarFrame = requestAnimationFrame(() => this.updateQueueBar());
      });
    }
    this.queueBarObserver.disconnect();
    this.queueBarObserved = el;
    this.queueBarObserver.observe(el);
  }

  updateQueueBar(): void {
    const view = Platform.isMobile ? null : this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? null;
    if (!view || !file || !this.isMaterialFile(file)) {
      this.queueBarObserver?.disconnect();
      this.queueBarObserved = null;
      this.queueBar?.addClass("is-hidden");
      return;
    }
    this.observeQueueBarContainer(view.containerEl);
    const bar = this.queueBar ?? this.createQueueBar();
    const entry = this.readMaterial(file);
    this.queueBarToggle?.setText(entry.status === "exhausted" ? "回归队列" : "移出队列");
    this.queueBarComplete?.setText(entry.status === "mined" ? "再淘一轮" : "已阅");
    this.queueBarCompanion?.setText("新建笔记");

    const rect = view.containerEl.getBoundingClientRect();
    if (rect.width < 220 || rect.height < 180) {
      bar.addClass("is-hidden");
      return;
    }
    bar.removeClass("is-hidden");
    bar.style.visibility = "hidden";
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    // 按钮变多后，窄窗格里整条会顶出左边界，宁可先不显示。
    if (width > rect.width - 36) {
      bar.addClass("is-hidden");
      return;
    }
    bar.style.left = `${Math.round(rect.right - width - 18)}px`;
    bar.style.top = `${Math.round(rect.top + (rect.height - height) / 2)}px`;
    bar.style.visibility = "visible";
  }

  async toggleQueueMembership(): Promise<void> {
    const file = this.activeMaterialFile();
    if (!file) {
      new Notice("当前笔记不在素材目录里");
      return;
    }
    const status: MaterialStatus = this.readMaterial(file).status === "exhausted" ? "pending" : "exhausted";
    await this.setMaterialStatus(file, status);
    this.updateQueueBar();
  }

  /** 标记「这一轮淘完了」：写入已淘 + 轮次 +1，然后打开队列里的下一篇。 */
  async completeMinedAndAdvance(): Promise<void> {
    const file = this.activeMaterialFile();
    if (!file) {
      new Notice("当前笔记不在素材目录里");
      return;
    }
    const queue = this.queueEntries();
    const index = queue.findIndex((entry) => entry.file.path === file.path);
    const next = index === -1 || index === queue.length - 1 ? queue[0] : queue[index + 1];
    await this.setMaterialStatus(file, "mined");
    if (next && next.file.path !== file.path) {
      await this.app.workspace.getLeaf(false).openFile(next.file);
    }
    this.updateQueueBar();
  }

  /** 保证目录存在（逐级创建），返回规范化后的路径。 */
  private async ensureFolder(folderPath: string): Promise<string> {
    const segments = folderPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const target = normalizePath(current);
      if (this.app.vault.getAbstractFileByPath(target)) continue;
      try {
        await this.app.vault.createFolder(target);
      } catch {
        // 并发或已存在时忽略
      }
    }
    return current;
  }

  /** 在右侧垂直分栏打开笔记，与当前笔记并列显示；右侧已有相邻窗格时直接复用，避免越分越窄。 */
  async openFileBeside(file: TFile, linktext = ""): Promise<void> {
    const current = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null;
    const neighbor = this.findBesideLeaf(current);
    if (neighbor) {
      await neighbor.openFile(file);
      await this.app.workspace.revealLeaf(neighbor);
    } else {
      await this.app.workspace.getLeaf("split", "vertical").openFile(file);
    }
    await this.revealSubpath(linktext);
  }

  /** 找当前窗格同一层、紧贴其右边的相邻窗格；没有或结构不确定时返回 null。 */
  private findBesideLeaf(leaf: WorkspaceLeaf | null): WorkspaceLeaf | null {
    if (!leaf) return null;
    const children = (leaf as unknown as { parent?: { children?: unknown[] } }).parent?.children;
    if (!Array.isArray(children)) return null;
    const index = children.indexOf(leaf);
    if (index === -1 || index === children.length - 1) return null;
    const neighbor = children[index + 1];
    if (!(neighbor instanceof WorkspaceLeaf)) return null;
    // 不依赖内部布局字段的语义，直接用几何位置确认它确实在右边。
    const container = (target: WorkspaceLeaf) => (target as unknown as { containerEl: HTMLElement }).containerEl;
    const sourceRight = container(leaf).getBoundingClientRect().right;
    const neighborLeft = container(neighbor).getBoundingClientRect().left;
    return neighborLeft >= sourceRight - 2 ? neighbor : null;
  }

  /** 打开后尽力滚动到链接小节（#标题 形式）；普通笔记链接没有小节，是空操作。 */
  private async revealSubpath(linktext: string): Promise<void> {
    const index = linktext.indexOf("#");
    if (index < 0) return;
    const subpath = linktext.slice(index + 1).trim();
    if (!subpath || subpath.startsWith("^")) return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const file = view?.file ?? null;
      if (view && file) {
        const heading = this.app.metadataCache.getFileCache(file)?.headings
          ?.find((item) => item.heading === subpath);
        if (heading) {
          const line = heading.position.start.line;
          view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } });
          return;
        }
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
  }

  /** 拦截内部链接跳转：素材笔记页（右下角有操作栏的页面）里的链接一律在右侧并列打开。 */
  private patchOpenLinkText(): void {
    if (Platform.isMobile) return;
    const workspace = this.app.workspace;
    const original = workspace.openLinkText.bind(workspace);
    const plugin = this;
    workspace.openLinkText = function (linktext, sourcePath, newLeaf, openState) {
      if (!newLeaf && sourcePath && plugin.isMaterialPath(sourcePath)) {
        const dest = plugin.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
        if (dest) return plugin.openFileBeside(dest, linktext);
      }
      return original(linktext, sourcePath, newLeaf, openState);
    };
    this.register(() => {
      workspace.openLinkText = original;
    });
  }

  /**
   * 为当前笔记在右侧新建一篇并列笔记（标题为当天日期），并在两篇底部互相写入双链。
   */
  async createCompanionNote(): Promise<void> {
    const source = this.activeMaterialFile();
    if (!source) {
      new Notice("当前笔记不在素材目录里");
      return;
    }
    const configured = this.settings.speechFolder.trim();
    if (!configured) {
      new Notice("请先在设置中配置“一分钟口语目录”");
      return;
    }
    let folder = configured;
    try {
      folder = await this.ensureFolder(configured);
    } catch {
      new Notice("创建一分钟口语目录失败，请检查库是否可写");
      return;
    }
    const baseName = this.formatDate(new Date(), "YYYY年MM月dd日");
    let target = normalizePath(`${folder}/${baseName}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(target)) {
      target = normalizePath(`${folder}/${baseName}-${suffix}.md`);
      suffix += 1;
    }
    try {
      const sourceLink = this.app.fileManager.generateMarkdownLink(source, target);
      const body = `---\n${JSON.stringify(this.statusPropertyName())}: []\n---\n\n## 来源笔记\n\n${sourceLink}\n`;
      const created = await this.app.vault.create(target, body);
      // 检查上一步是否写入过，避免重复点击时重复追加。
      const sourceContent = await this.app.vault.read(source);
      if (!sourceContent.includes(`[[${created.basename}]]`)) {
        const newNoteLink = this.app.fileManager.generateMarkdownLink(created, source.path);
        await this.app.vault.process(source, (content) => appendLinkAtBottom(content, newNoteLink));
      }
      // 在右侧新分栏打开，与原笔记并列显示。
      await this.openFileBeside(created);
      new Notice(`已新建笔记：${created.basename}`);
    } catch {
      new Notice("新建笔记失败，请检查库是否可写");
      return;
    }
    this.updateQueueBar();
  }

  async openNextMaterial(): Promise<void> {
    const current = this.activeMaterialFile();
    const queue = this.queueEntries();
    if (!queue.length) {
      new Notice("淘金队列是空的");
      return;
    }
    const index = current ? queue.findIndex((entry) => entry.file.path === current.path) : -1;
    const target = index === -1 || index === queue.length - 1 ? queue[0] : queue[index + 1];
    if (current && target.file.path === current.path) {
      new Notice("队列里没有别的素材了");
      return;
    }
    if (index === queue.length - 1) new Notice(`已回到队首：${target.file.basename}`);
    await this.app.workspace.getLeaf(false).openFile(target.file);
  }

  private async updateHighlightPaths(newPath: string, oldPath: string): Promise<void> {
    let changed = false;
    this.settings.highlights.forEach((highlight) => {
      if (highlight.sourcePath === oldPath || highlight.sourcePath.startsWith(`${oldPath}/`)) {
        highlight.sourcePath = `${newPath}${highlight.sourcePath.slice(oldPath.length)}`;
        changed = true;
      }
      highlight.aiNotes?.forEach((note) => {
        if (note.path === oldPath || note.path.startsWith(`${oldPath}/`)) {
          note.path = `${newPath}${note.path.slice(oldPath.length)}`;
          changed = true;
        }
      });
    });
    if (changed) await this.saveSettings();
  }

  private async openInEmptyLeaf(): Promise<void> {
    if (!this.settings.openAsStartupPage || this.isOpeningStartupPage) return;
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length > 0) return;

    const emptyLeaf = this.app.workspace.getLeavesOfType("empty")[0];
    if (!emptyLeaf) return;

    this.isOpeningStartupPage = true;
    try {
      await emptyLeaf.setViewState({ type: VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(emptyLeaf);
    } finally {
      this.isOpeningStartupPage = false;
    }
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData();
    const hasLegacyStatuses = saved != null && ("editingValue" in saved || "publishedValue" in saved);
    if (hasLegacyStatuses) {
      delete saved.editingValue;
      delete saved.publishedValue;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.ai = normalizeAISettings(saved?.ai);
    if (!Array.isArray(this.settings.highlights)) this.settings.highlights = [];
    // 旧版本的 data.json 没有 goal 字段，这里合并默认值，避免读取到 undefined。
    this.settings.goal = Object.assign({}, DEFAULT_SETTINGS.goal, saved?.goal ?? {});
    if (hasLegacyStatuses || saved?.ai?.builtinPromptVersion !== 1) await this.saveData(this.settings);
  }

  async saveSettings(refreshViews = true): Promise<void> {
    await this.saveData(this.settings);
    if (!refreshViews) return;
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof OneMinuteEnglishView) view.render();
    });
    this.app.workspace.getLeavesOfType(HIGHLIGHTS_VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof HighlightsView) view.render();
    });
    this.app.workspace.getLeavesOfType(GOAL_VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof GoalView) view.render();
    });
  }
}

class HighlightsView extends ItemView {
  constructor(leaf: WorkspaceLeaf, protected readonly plugin: OneMinuteEnglishPlugin) {
    super(leaf);
  }

  getViewType(): string { return HIGHLIGHTS_VIEW_TYPE; }
  getDisplayText(): string { return "高亮"; }
  getIcon(): string { return "highlighter"; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ome-highlights-view");

    const activeFile = this.app.workspace.getActiveFile();
    const highlights = activeFile
      ? this.plugin.settings.highlights.filter((highlight) => highlight.sourcePath === activeFile.path)
      : [];

    const heading = root.createDiv({ cls: "ome-highlights-heading" });
    const title = heading.createDiv({ cls: "ome-highlights-title" });
    const icon = title.createSpan();
    setIcon(icon, "highlighter");
    title.createEl("h2", { text: "高亮" });
    title.createSpan({ cls: "ome-count", text: String(highlights.length) });
    root.createDiv({ cls: "ome-highlights-hint", text: "在笔记中选中文字，点击选区上方的“加入高亮”。" });

    const list = root.createDiv({ cls: "ome-highlight-list" });
    highlights.forEach((highlight) => this.renderHighlight(list, highlight));
  }

  protected renderHighlight(parent: HTMLElement, highlight: HighlightNote): void {
    const card = parent.createDiv({ cls: "ome-highlight-card" });
    const head = card.createDiv({ cls: "ome-highlight-card-head" });
    head.createDiv({ cls: "ome-highlight-text", text: highlight.text });

    const source = card.createEl("button", {
      cls: "ome-highlight-source",
      text: highlight.sourcePath,
      attr: { title: "打开原笔记" },
    });
    source.addEventListener("click", () => void this.openSource(highlight));

    const label = card.createEl("label", { cls: "ome-highlight-note-label", text: "补充内容" });
    const textarea = card.createEl("textarea", {
      cls: "ome-highlight-note",
      text: highlight.note,
      attr: { placeholder: "添加自己的理解、例句或备注…", "aria-label": `编辑 ${highlight.text} 的补充内容` },
    });
    label.htmlFor = textarea.id = `ome-highlight-note-${highlight.id}`;
    textarea.dataset.highlightId = highlight.id;
    textarea.value = highlight.note;
    textarea.addEventListener("input", () => { highlight.note = textarea.value; });
    textarea.addEventListener("blur", () => void this.plugin.saveSettings(false));
    textarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        textarea.blur();
      }
    });

    const results = card.createDiv({ cls: "ome-highlight-ai-results" });
    results.dataset.highlightId = highlight.id;
    this.renderAIResults(results, highlight);

    const actions = card.createDiv({ cls: "ome-highlight-card-actions" });
    const remove = actions.createEl("button", {
      cls: "ome-highlight-delete",
      attr: { "aria-label": "删除高亮", title: "删除高亮" },
    });
    setIcon(remove, "trash-2");
    remove.addEventListener("click", () => this.plugin.requestDeleteHighlight(highlight));
    const createNote = actions.createEl("button", {
      cls: "ome-highlight-create-note",
      attr: { "aria-label": "将高亮转为笔记", title: "将高亮转为笔记" },
    });
    setIcon(createNote, "file-plus-2");
    createNote.addEventListener("click", () => void this.plugin.convertHighlightToNote(highlight));
    const ai = actions.createEl("button", {
      cls: "ome-highlight-ai",
      attr: { "aria-label": "选择 AI 提示词", title: "AI：选择提示词生成", "aria-haspopup": "menu" },
    });
    ai.dataset.highlightId = highlight.id;
    this.updateAIButton(ai, highlight.id);
    ai.addEventListener("click", () => {
      highlight.note = textarea.value;
      this.plugin.showHighlightAIMenu(highlight, ai);
    });
  }

  refreshSupplement(highlight: HighlightNote): void {
    this.contentEl.querySelectorAll<HTMLTextAreaElement>(".ome-highlight-note").forEach((textarea) => {
      if (textarea.dataset.highlightId === highlight.id) textarea.value = highlight.note;
    });
  }

  refreshAIState(id: string): void {
    this.contentEl.querySelectorAll<HTMLButtonElement>(".ome-highlight-ai").forEach((button) => {
      if (button.dataset.highlightId === id) this.updateAIButton(button, id);
    });
  }

  private updateAIButton(button: HTMLButtonElement, id: string): void {
    const pending = this.plugin.isHighlightAIPending(id);
    setIcon(button, pending ? "loader-circle" : "sparkles");
    button.classList.toggle("ome-ai-spinner", pending);
    button.setAttribute("aria-busy", String(pending));
    button.setAttribute("aria-label", pending ? "AI 正在生成，查看进度" : "选择 AI 提示词");
    button.title = pending ? "AI 正在生成，点击查看进度" : "AI：选择提示词生成";
  }

  refreshAIResults(highlight: HighlightNote): void {
    this.contentEl.querySelectorAll<HTMLElement>(".ome-highlight-ai-results").forEach((container) => {
      if (container.dataset.highlightId === highlight.id) this.renderAIResults(container, highlight);
    });
  }

  private renderAIResults(container: HTMLElement, highlight: HighlightNote): void {
    container.empty();
    for (const note of highlight.aiNotes ?? []) {
      const row = container.createDiv({ cls: "ome-highlight-ai-note" });
      const icon = row.createSpan({ cls: "ome-highlight-ai-note-icon" });
      setIcon(icon, "file-text");
      const link = row.createEl("a", {
        cls: "ome-highlight-ai-note-link",
        text: note.path.split("/").pop()?.replace(/\.md$/i, "") || note.promptName,
        attr: { href: note.path, title: `打开笔记：${note.path}` },
      });
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void this.plugin.openAINote(note.path);
      });
    }
  }

  protected async openSource(highlight: HighlightNote): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(highlight.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("找不到原笔记");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const renderedHighlight = markdownView.containerEl.querySelector<HTMLElement>(
        `.ome-note-highlight[data-ome-highlight-id="${highlight.id}"]`,
      );
      if (renderedHighlight) {
        renderedHighlight.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }

    // 编辑器可能尚未渲染远离视口的内容；只滚动，不设置光标，避免展开 <mark> 源码。
    const marker = `data-ome-highlight-id="${highlight.id}"`;
    const offset = markdownView.editor.getValue().indexOf(marker);
    if (offset < 0) return;
    const position = markdownView.editor.offsetToPos(offset);
    markdownView.editor.scrollIntoView({ from: position, to: position }, true);
  }
}

class GoalView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: OneMinuteEnglishPlugin) {
    super(leaf);
  }

  getViewType(): string { return GOAL_VIEW_TYPE; }
  getDisplayText(): string { return "目标进度"; }
  getIcon(): string { return "target"; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.vault.on("create", () => this.render()));
    this.registerEvent(this.app.vault.on("delete", () => this.render()));
    this.registerEvent(this.app.vault.on("rename", () => this.render()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.render()));
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ome-goal-view");

    const goal = this.plugin.settings.goal;
    const header = root.createDiv({ cls: "ome-goal-header" });
    const headerIcon = header.createSpan({ cls: "ome-goal-header-icon" });
    setIcon(headerIcon, "target");
    const headerText = header.createDiv({ cls: "ome-goal-header-text" });
    headerText.createEl("h2", { text: "目标进度" });
    headerText.createDiv({
      cls: "ome-goal-subtitle",
      text: goal.folder.trim() ? goal.folder : "尚未设置目标目录",
    });
    const settings = header.createEl("button", {
      cls: "ome-icon-button",
      attr: { "aria-label": "打开目标设置", title: "打开目标设置" },
    });
    setIcon(settings, "settings");
    settings.addEventListener("click", () => {
      const appWithSettings = this.app as App & { setting: { open(): void; openTabById(id: string): void } };
      appWithSettings.setting.open();
      appWithSettings.setting.openTabById(this.plugin.manifest.id);
    });

    if (!goal.folder.trim()) {
      this.renderNotice(root, "点右上角齿轮，在设置 → 目标里选择目标目录并设定数量与截止日期。", "target");
      return;
    }

    const progress = this.plugin.goalProgress();
    this.renderProgressCard(root, progress);
    this.renderStats(root, progress);

    const entries = this.plugin.goalEntries();
    this.renderTaskList(root, entries);
  }

  private renderProgressCard(root: HTMLElement, progress: ReturnType<OneMinuteEnglishPlugin["goalProgress"]>): void {
    const card = root.createDiv({ cls: "ome-goal-progress" });
    const top = card.createDiv({ cls: "ome-goal-progress-top" });
    const label = top.createDiv({ cls: "ome-goal-progress-label" });
    label.createSpan({ text: "完成进度" });
    label.createSpan({
      cls: "ome-goal-progress-count",
      text: `${progress.completed} / ${progress.target} 篇`,
    });
    const percent = Math.round(progress.ratio * 100);
    top.createSpan({ cls: `ome-goal-progress-percent${percent >= 100 ? " is-complete" : ""}`, text: `${percent}%` });

    const track = card.createDiv({
      cls: "ome-goal-progress-track",
      attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) },
    });
    track.createDiv({ cls: "ome-goal-progress-fill" }).style.width = `${percent}%`;
  }

  private renderStats(root: HTMLElement, progress: ReturnType<OneMinuteEnglishPlugin["goalProgress"]>): void {
    const stats = root.createDiv({ cls: "ome-goal-stats" });
    const daysText = !progress.hasDeadline
      ? "未设置"
      : progress.expired
        ? "已过期"
        : String(progress.daysLeft);
    const cards: { label: string; value: string; danger?: boolean }[] = [
      { label: "剩余天数", value: daysText, danger: progress.expired },
      { label: "完成数量", value: String(progress.completed) },
      { label: "剩余数量", value: String(progress.remaining) },
    ];
    cards.forEach((item) => {
      const card = stats.createDiv({ cls: `ome-goal-stat${item.danger ? " is-danger" : ""}` });
      card.createDiv({ cls: "ome-goal-stat-value", text: item.value });
      card.createDiv({ cls: "ome-goal-stat-label", text: item.label });
    });
  }

  private renderTaskList(root: HTMLElement, entries: { file: TFile; done: boolean }[]): void {
    const section = root.createDiv({ cls: "ome-goal-tasks" });
    const heading = section.createDiv({ cls: "ome-goal-tasks-heading" });
    heading.createEl("h3", { text: "任务清单" });
    heading.createSpan({ cls: "ome-count", text: String(entries.length) });

    if (!entries.length) {
      this.renderNotice(section, "目标目录里还没有笔记。", "file-text");
      return;
    }

    const list = section.createDiv({ cls: "ome-goal-task-list" });
    entries.forEach((entry) => {
      const item = list.createDiv({ cls: `ome-goal-task${entry.done ? " is-done" : ""}` });
      item.setAttr("title", entry.file.path);

      const check = item.createSpan({ cls: "ome-goal-task-check" });
      setIcon(check, entry.done ? "check-circle-2" : "circle");

      const body = item.createDiv({ cls: "ome-goal-task-body" });
      body.createDiv({ cls: "ome-goal-task-title", text: entry.file.basename });
      const preview = body.createDiv({ cls: "ome-goal-task-preview", text: "读取中…" });
      void this.plugin.previewText(entry.file).then((text) => {
        if (!preview.isConnected) return;
        preview.setText(text || "（空笔记）");
      });

      const meta = body.createDiv({ cls: "ome-goal-task-meta" });
      meta.createSpan({ cls: `ome-goal-task-status${entry.done ? " is-done" : ""}`, text: entry.done ? "已完成" : "进行中" });
      meta.createSpan({ text: this.plugin.dateText(entry.file.stat.mtime) });

      item.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(entry.file));
    });
  }

  private renderNotice(parent: HTMLElement, text: string, iconName: string): void {
    const empty = parent.createDiv({ cls: "ome-empty ome-goal-empty" });
    const icon = empty.createSpan();
    setIcon(icon, iconName);
    empty.createDiv({ text });
  }
}

type HomeTab = "queue" | "exhausted" | "highlights";

class OneMinuteEnglishView extends ItemView {
  private renderToken = 0;
  /** 当前 tab：固定 tab 用 HomeTab，目录 tab 用 customTabs 的 id。 */
  private activeTab: string = "queue";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: OneMinuteEnglishPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "One Minute English"; }
  getIcon(): string { return "languages"; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.vault.on("create", () => this.render()));
    this.registerEvent(this.app.vault.on("delete", () => this.render()));
    this.registerEvent(this.app.vault.on("rename", () => this.render()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.render()));
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ome-page");
    this.renderToken += 1;
    this.renderHeader(root);

    const hasMaterialFolder = Boolean(this.plugin.settings.materialFolder.trim());
    const all = hasMaterialFolder ? this.plugin.materials() : [];
    const queue = this.plugin.sortMaterials(all.filter((entry) => entry.status !== "exhausted"));
    const exhausted = all
      .filter((entry) => entry.status === "exhausted")
      .sort((a, b) => b.addedAt - a.addedAt);
    const highlights = [...this.plugin.settings.highlights].sort((a, b) => b.createdAt - a.createdAt);

    this.renderTabs(root, {
      queue: queue.length,
      exhausted: exhausted.length,
      highlights: highlights.length,
    });

    const activeCustom = this.plugin.settings.customTabs.find((tab) => tab.id === this.activeTab);
    if (activeCustom) {
      this.renderCustomTab(root, activeCustom);
      this.renderQuickCaptureButton(root);
      return;
    }

    if (!hasMaterialFolder) {
      this.renderNotice(root, "请先在 One Minute English 设置中配置“素材目录”。", "folder-open");
      this.renderFooter(root);
      this.renderQuickCaptureButton(root);
      return;
    }

    if (this.activeTab === "highlights") {
      const sources = new Set(highlights.map((highlight) => highlight.sourcePath)).size;
      this.renderHint(root, [`共 ${highlights.length} 条`, `来自 ${sources} 篇笔记`]);
      this.renderHighlightGrid(root, highlights);
      this.renderQuickCaptureButton(root);
      return;
    }

    if (this.activeTab === "queue") {
      const pendingEntries = queue.filter((entry) => entry.status === "pending");
      const minedCount = queue.length - pendingEntries.length;
      const oldestDays = pendingEntries.length
        ? this.plugin.addedDaysAgo(pendingEntries[pendingEntries.length - 1].addedAt)
        : 0;
      const parts = [`待淘 ${pendingEntries.length} 篇 · 新收的排前面`];
      if (oldestDays >= AGE_STALE_DAYS) parts.push(`最老已等 ${oldestDays} 天`);
      parts.push(minedCount > 0 ? `已淘 ${minedCount} 篇 · 最久没碰的优先` : "还没有已淘的素材");
      this.renderHint(root, parts);
      this.renderCardGrid(root, queue, {
        markCurrent: true,
        emptyText: "队列里没有素材了。往素材目录加一篇，或把标记为“淘干”的笔记改回“待淘”。",
        emptyIcon: "check-check",
      });
    } else {
      this.renderHint(root, [
        `共 ${exhausted.length} 篇`,
        "在笔记属性里把「素材状态」改回「待淘」即可重新入队",
      ]);
      this.renderCardGrid(root, exhausted, {
        markCurrent: false,
        emptyText: "没有移出队列的素材。阅读时点右下角「移出队列」，那篇就会收到这里。",
        emptyIcon: "archive",
      });
    }

    this.renderFooter(root);
    this.renderQuickCaptureButton(root);
  }

  private renderTabs(root: HTMLElement, counts: Record<HomeTab, number>): void {
    const bar = root.createDiv({ cls: "ome-home-tabs" });
    const tabs: { id: HomeTab; label: string; iconName: string }[] = [
      { id: "queue", label: "队列中", iconName: "list-ordered" },
      { id: "exhausted", label: "不在队列", iconName: "archive" },
      { id: "highlights", label: "高亮笔记", iconName: "highlighter" },
    ];
    tabs.forEach((tab) => {
      const button = bar.createEl("button", { cls: `ome-home-tab${this.activeTab === tab.id ? " is-active" : ""}` });
      const icon = button.createSpan({ cls: "ome-home-tab-icon" });
      setIcon(icon, tab.iconName);
      button.createSpan({ cls: "ome-home-tab-label", text: tab.label });
      button.createSpan({ cls: "ome-home-tab-count", text: String(counts[tab.id]) });
      button.addEventListener("click", () => {
        if (this.activeTab === tab.id) return;
        this.activeTab = tab.id;
        this.render();
      });
    });

    // 目录 tab：点击切换，悬停出现 × 可移除。
    this.plugin.settings.customTabs.forEach((tab) => {
      const count = this.plugin.filesInFolder(tab.path).length;
      const button = bar.createEl("button", {
        cls: `ome-home-tab is-custom${this.activeTab === tab.id ? " is-active" : ""}`,
        attr: { title: tab.path },
      });
      const icon = button.createSpan({ cls: "ome-home-tab-icon" });
      setIcon(icon, "folder");
      button.createSpan({ cls: "ome-home-tab-label", text: tab.name });
      button.createSpan({ cls: "ome-home-tab-count", text: String(count) });
      const remove = button.createSpan({
        cls: "ome-home-tab-remove",
        attr: { "aria-label": `移除标签 ${tab.name}`, title: "移除标签" },
      });
      setIcon(remove, "x");
      button.addEventListener("click", () => {
        if (this.activeTab === tab.id) return;
        this.activeTab = tab.id;
        this.render();
      });
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        this.plugin.settings.customTabs = this.plugin.settings.customTabs.filter((item) => item.id !== tab.id);
        if (this.activeTab === tab.id) this.activeTab = "queue";
        void this.plugin.saveSettings();
        this.render();
      });
    });

    // 加号：选一个目录添加为 tab。
    const add = bar.createEl("button", {
      cls: "ome-home-tab-add",
      attr: { "aria-label": "添加目录标签", title: "把一个目录添加为标签" },
    });
    setIcon(add, "plus");
    add.addEventListener("click", () => {
      new FolderSuggestModal(this.app, (folder) => {
        const existing = this.plugin.settings.customTabs.find((item) => item.path === folder.path);
        if (existing) {
          this.activeTab = existing.id;
          this.render();
          return;
        }
        const tab: FolderTab = { id: `tab-${Date.now().toString(36)}`, name: folder.name, path: folder.path };
        this.plugin.settings.customTabs = [...this.plugin.settings.customTabs, tab];
        this.activeTab = tab.id;
        void this.plugin.saveSettings();
        this.render();
      }).open();
    });
  }

  /** 目录 tab 内容：该目录下的笔记按创建时间新→旧排列。 */
  private renderCustomTab(root: HTMLElement, tab: FolderTab): void {
    const files = this.plugin.filesInFolder(tab.path).sort((a, b) => b.stat.ctime - a.stat.ctime);
    this.renderHint(root, [`共 ${files.length} 篇`, "按创建时间排列，最新的在最前"]);
    if (!files.length) {
      this.renderNotice(root, "这个目录里还没有 Markdown 文档。", "folder-open");
      return;
    }
    const wrap = root.createDiv({ cls: "ome-grid-wrap" });
    const grid = wrap.createDiv({ cls: "ome-card-grid" });
    const token = this.renderToken;
    files.forEach((file) => {
      const card = grid.createDiv({ cls: "ome-note-card" });
      card.setAttr("title", file.path);
      card.createDiv({ cls: "ome-note-card-head" }).createEl("h3", { text: file.basename });

      const body = card.createDiv({ cls: "ome-note-card-body", text: "读取中…" });
      void this.plugin.previewText(file).then((preview) => {
        if (token !== this.renderToken || !body.isConnected) return;
        body.setText(preview || "（空笔记）");
      });

      const meta = card.createDiv({ cls: "ome-note-card-meta" });
      meta.createSpan({ text: `创建于 ${this.plugin.dateText(file.stat.ctime)}` });

      card.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(file));
    });
  }

  private renderHighlightGrid(root: HTMLElement, highlights: HighlightNote[]): void {
    if (!highlights.length) {
      this.renderNotice(root, "还没有高亮。在笔记里选中文字，点选区上方的「加入高亮」即可收集。", "highlighter");
      return;
    }
    const wrap = root.createDiv({ cls: "ome-grid-wrap" });
    const grid = wrap.createDiv({ cls: "ome-card-grid" });
    highlights.forEach((highlight) => {
      const card = grid.createDiv({ cls: "ome-note-card is-highlight" });
      card.setAttr("title", highlight.sourcePath);
      card.createDiv({ cls: "ome-note-card-quote", text: highlight.text });
      if (highlight.note.trim()) {
        card.createDiv({ cls: "ome-note-card-note", text: highlight.note });
      }
      const meta = card.createDiv({ cls: "ome-note-card-meta" });
      meta.createSpan({ text: this.sourceName(highlight.sourcePath) });
      meta.createSpan({ text: this.plugin.dateText(highlight.createdAt) });
      card.addEventListener("click", () => void this.openHighlightSource(highlight));
    });
  }

  private sourceName(path: string): string {
    return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
  }

  private async openHighlightSource(highlight: HighlightNote): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(highlight.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("找不到高亮来源笔记，可能已被移动或删除");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const target = markdownView.containerEl.querySelector<HTMLElement>(
        `.ome-note-highlight[data-ome-highlight-id="${highlight.id}"]`,
      );
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "ome-header ome-home-header" });
    const brand = header.createDiv({ cls: "ome-brand" });
    const logo = brand.createSpan({ cls: "ome-brand-icon" });
    setIcon(logo, "layers-3");
    brand.createEl("h1", { text: "一分钟表达练习" });
    const settings = header.createEl("button", { cls: "ome-icon-button", attr: { "aria-label": "打开设置" } });
    setIcon(settings, "settings");
    settings.addEventListener("click", () => {
      const appWithSettings = this.app as App & { setting: { open(): void; openTabById(id: string): void } };
      appWithSettings.setting.open();
      appWithSettings.setting.openTabById(this.plugin.manifest.id);
    });
  }

  private renderCardGrid(
    root: HTMLElement,
    entries: MaterialEntry[],
    options: { markCurrent: boolean; emptyText: string; emptyIcon: string },
  ): void {
    if (!entries.length) {
      this.renderNotice(root, options.emptyText, options.emptyIcon);
      return;
    }
    const wrap = root.createDiv({ cls: "ome-grid-wrap" });
    const grid = wrap.createDiv({ cls: "ome-card-grid" });
    const token = this.renderToken;
    entries.forEach((entry, index) => {
      const isCurrent = options.markCurrent && index === 0;
      const card = grid.createDiv({ cls: `ome-note-card${isCurrent ? " is-current" : ""}` });
      card.setAttr("title", entry.file.path);

      const head = card.createDiv({ cls: "ome-note-card-head" });
      head.createEl("h3", { text: entry.file.basename });

      const body = card.createDiv({ cls: "ome-note-card-body", text: "读取中…" });
      void this.plugin.previewText(entry.file).then((text) => {
        if (token !== this.renderToken || !body.isConnected) return;
        body.setText(text || "（空笔记）");
      });

      const meta = card.createDiv({ cls: "ome-note-card-meta" });
      meta.createSpan({ cls: `ome-badge ome-badge-${entry.status}`, text: this.plugin.statusLabel(entry.status) });
      if (entry.status === "mined") {
        meta.createSpan({
          text: entry.rounds > 0
            ? `第 ${entry.rounds} 轮 · 上次 ${this.plugin.dateText(entry.minedAt)}`
            : `上次 ${this.plugin.dateText(entry.minedAt)}`,
        });
      } else {
        const age = this.plugin.addedAgeText(entry.addedAt);
        meta.createSpan({ cls: `ome-age${age.stale ? " is-stale" : ""}`, text: age.text });
      }
      if (entry.seedCount) meta.createSpan({ text: `${entry.seedCount} 处种子` });

      card.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(entry.file));
    });
  }

  private renderHint(root: HTMLElement, parts: string[]): void {
    const summary = root.createDiv({ cls: "ome-queue-summary" });
    parts.forEach((text, index) => {
      if (index > 0) summary.createSpan({ cls: "ome-queue-dot", text: "·" });
      summary.createSpan({ text });
    });
  }

  private renderNotice(parent: HTMLElement, text: string, iconName: string): void {
    const empty = parent.createDiv({ cls: "ome-empty ome-home-empty" });
    const icon = empty.createSpan();
    setIcon(icon, iconName);
    empty.createDiv({ text });
  }

  private renderFooter(root: HTMLElement): void {
    root.createDiv({ cls: "ome-bottom-spacer", attr: { "aria-hidden": "true" } });
  }

  private renderQuickCaptureButton(root: HTMLElement): void {
    const button = root.createEl("button", {
      cls: "ome-quick-capture-button",
      attr: { "aria-label": "新建快速记录" },
    });
    setIcon(button, "plus");
    button.addEventListener("click", () => {
      if (!this.plugin.settings.quickCaptureFolder.trim() || !this.plugin.settings.quickCaptureFilenameFormat.trim()) {
        new Notice("请先在 One Minute English 设置中配置“快速记录目录”和“文件名时间格式”");
        return;
      }
      new QuickCaptureModal(this.app, (content) => this.saveQuickCapture(content)).open();
    });
  }

  private async saveQuickCapture(content: string): Promise<void> {
    const folder = this.plugin.settings.quickCaptureFolder.replace(/^\/+|\/+$/g, "");
    const targetFolder = this.app.vault.getAbstractFileByPath(folder);
    if (!(targetFolder instanceof TFolder)) {
      new Notice("配置的快速记录目录不存在，请重新选择");
      return;
    }
    const formatted = this.plugin.formatDate(new Date(), this.plugin.settings.quickCaptureFilenameFormat);
    const safeName = formatted.replace(/[\\/:*?"<>|]/g, "-").trim();
    if (!safeName) {
      new Notice("文件名时间格式无法生成有效文件名，请重新配置");
      return;
    }
    let path = normalizePath(`${folder}/${safeName}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/${safeName}-${suffix}.md`);
      suffix += 1;
    }
    const file = await this.app.vault.create(path, content);
    new Notice(`已保存：${file.basename}`);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

}

class OneMinuteEnglishSettingTab extends PluginSettingTab {
  private activeTab: "general" | "goal" | "ai" = "general";

  constructor(app: App, private readonly plugin: OneMinuteEnglishPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ome-settings");
    containerEl.createEl("h2", { text: "One Minute English 设置" });
    const tabs = containerEl.createDiv({ cls: "ome-settings-tabs", attr: { "aria-label": "设置分类" } });
    const tabItems = [["general", "常规"], ["goal", "目标"], ["ai", "AI"]] as const;
    tabItems.forEach(([id, label], index) => {
      const button = tabs.createEl("button", {
        text: label,
        cls: `ome-settings-tab${this.activeTab === id ? " is-active" : ""}`,
        attr: { type: "button", "aria-pressed": String(this.activeTab === id) },
      });
      button.addEventListener("click", () => {
        this.activeTab = id;
        this.display();
        this.containerEl.querySelectorAll<HTMLButtonElement>(".ome-settings-tab")[index]?.focus();
      });
    });
    if (this.activeTab === "ai") {
      renderAISettings(containerEl.createDiv({ cls: "ome-ai-settings" }), this.app, this.plugin.settings.ai,
        () => this.plugin.saveSettings(false));
      return;
    }
    if (this.activeTab === "goal") {
      this.renderGoalSettings(containerEl);
      return;
    }
    new Setting(containerEl)
      .setName("设为启动页面")
      .setDesc("Obsidian 启动或所有标签页关闭后，自动显示 One Minute English 主页。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.openAsStartupPage).onChange(async (value) => {
        this.plugin.settings.openAsStartupPage = value;
        await this.plugin.saveSettings();
        if (value) await this.plugin.activateView();
      }));
    new Setting(containerEl)
      .setName("方括号转待办")
      .setDesc("编辑笔记时在行首输入 [] 再按空格，自动换成待办复选框 - [ ]。已有列表符号和缩进会保留，行中间的 [] 不转换。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.bracketToCheckbox).onChange(async (value) => {
        this.plugin.settings.bracketToCheckbox = value;
        await this.plugin.saveSettings();
      }));
    containerEl.createEl("p", { cls: "setting-item-description", text: "目录路径均相对于当前 Obsidian 库；列表会自动包含所有子目录中的 Markdown 文档。" });
    this.folderSetting("素材目录", "主页“素材”标签加载的目录。", "materialFolder");
    this.folderSetting("话题目录", "侧栏高亮卡片上「转成笔记」和「AI 生成」产出的笔记保存到这里。", "topicFolder");
    this.folderSetting("快速记录目录", "右下角 + 按钮创建的 Markdown 文档保存到这里。", "quickCaptureFolder");
    this.folderSetting("一分钟口语目录", "阅读素材时点「新建笔记」，新建的口播稿保存到这个目录。", "speechFolder");
    new Setting(containerEl)
      .setName("文件名时间格式")
      .setDesc("快速记录的文件名格式。支持 YYYY、YY、MM、M、dd、d、HH、H、mm、m、ss、s，例如：YYYY年MM月dd日。")
      .addText((text) => text.setPlaceholder("YYYY年MM月dd日").setValue(this.plugin.settings.quickCaptureFilenameFormat).onChange(async (value) => {
        this.plugin.settings.quickCaptureFilenameFormat = value.trim();
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("状态属性")
      .setDesc("用于区分话题状态的 Frontmatter / Properties 属性名，例如 status。")
      .addText((text) => text.setPlaceholder("status").setValue(this.plugin.settings.statusProperty).onChange(async (value) => {
        this.plugin.settings.statusProperty = value.trim();
        await this.plugin.saveSettings();
      }));
    this.valueSetting("“已完成”对应值", "completedValue", "已完成");

    containerEl.createEl("h3", { text: "素材状态" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "状态写在素材笔记的 Frontmatter / Properties 里，没有该属性的笔记视为“待淘”。待淘排队列最前，已淘排最后但会再次轮到，淘干不进入队列。",
    });
    new Setting(containerEl)
      .setName("素材状态属性")
      .setDesc("记录素材状态的属性名。")
      .addText((text) => text.setPlaceholder("素材状态").setValue(this.plugin.settings.materialStatusProperty).onChange(async (value) => {
        this.plugin.settings.materialStatusProperty = value.trim();
        await this.plugin.saveSettings();
      }));
    this.valueSetting("“待淘”对应值", "pendingValue", "待淘");
    this.valueSetting("“已淘”对应值", "minedValue", "已淘");
    this.valueSetting("“淘干”对应值", "exhaustedValue", "淘干");
    new Setting(containerEl)
      .setName("上次淘的时间属性")
      .setDesc("已淘的素材按这个属性排序，最久没碰的排在最前面。")
      .addText((text) => text.setPlaceholder("上次淘的时间").setValue(this.plugin.settings.minedAtProperty).onChange(async (value) => {
        this.plugin.settings.minedAtProperty = value.trim();
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("淘过轮次属性")
      .setDesc("每点一次「已阅」就加一。")
      .addText((text) => text.setPlaceholder("淘过轮次").setValue(this.plugin.settings.mineRoundProperty).onChange(async (value) => {
        this.plugin.settings.mineRoundProperty = value.trim();
        await this.plugin.saveSettings();
      }));
  }

  private folderSetting(name: string, description: string, key: "materialFolder" | "topicFolder" | "quickCaptureFolder" | "speechFolder"): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => text.setPlaceholder("例如：英语/素材").setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value.replace(/^\/+|\/+$/g, "");
        await this.plugin.saveSettings();
      }))
      .addButton((button) => button.setButtonText("选择目录").onClick(() => {
        new FolderSuggestModal(this.app, (folder) => {
          this.plugin.settings[key] = folder.path;
          void this.plugin.saveSettings().then(() => this.display());
        }).open();
      }));
  }

  private valueSetting(
    name: string,
    key: "completedValue" | "pendingValue" | "minedValue" | "exhaustedValue",
    placeholder: string,
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc("该属性为此值时归入对应标签；也支持属性值为列表。")
      .addText((text) => text.setPlaceholder(placeholder).setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value.trim();
        await this.plugin.saveSettings();
      }));
  }

  private renderGoalSettings(containerEl: HTMLElement): void {
    const goal = this.plugin.settings.goal;
    containerEl.createEl("h3", { text: "目标进度" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "配置后可在右侧边栏打开“目标进度”面板（命令面板搜索“打开目标进度面板”，或点击左侧目标图标）。",
    });
    new Setting(containerEl)
      .addButton((button) => button.setButtonText("打开目标进度面板").onClick(() => {
        void this.plugin.activateGoalView();
      }));
    new Setting(containerEl)
      .setName("目标描述")
      .setDesc("说明这个目标想达成什么，写给自己看。")
      .setClass("ome-goal-description-setting")
      .addTextArea((area) => {
        area.inputEl.rows = 5;
        area.setPlaceholder("例如：用三个月把 30 篇口语稿写出来并录音，先在英语/目标目录里攒够作品。")
          .setValue(goal.description).onChange(async (value) => {
            goal.description = value;
            await this.plugin.saveSettings(false);
          });
      });
    new Setting(containerEl)
      .setName("目录数量")
      .setDesc("希望完成多少篇笔记，用于计算进度条比例。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.setPlaceholder("例如：30").setValue(String(goal.count || "")).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          goal.count = Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("目标目录")
      .setDesc("统计哪个目录下的笔记，包含所有子目录。")
      .addText((text) => text.setPlaceholder("例如：英语/目标").setValue(goal.folder).onChange(async (value) => {
        goal.folder = value.replace(/^\/+|\/+$/g, "");
        await this.plugin.saveSettings();
      }))
      .addButton((button) => button.setButtonText("选择目录").onClick(() => {
        new FolderSuggestModal(this.app, (folder) => {
          goal.folder = folder.path;
          void this.plugin.saveSettings().then(() => this.display());
        }).open();
      }));
    new Setting(containerEl)
      .setName("截止日期")
      .setDesc("目标完成的最后日期，格式 YYYY-MM-DD；留空表示不设置期限。")
      .addText((text) => {
        text.inputEl.type = "date";
        text.setValue(goal.deadline).onChange(async (value) => {
          goal.deadline = value.trim();
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("判断完成的属性")
      .setDesc("笔记 Frontmatter / Properties 中用于判断是否完成的属性名，例如 status。")
      .addText((text) => text.setPlaceholder("例如：状态").setValue(goal.property).onChange(async (value) => {
        goal.property = value.trim();
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("判断完成的属性值")
      .setDesc("当上述属性等于此值时，该笔记视为已完成；留空则只要存在该属性就算完成。")
      .addText((text) => text.setPlaceholder("例如：已完成").setValue(goal.value).onChange(async (value) => {
        goal.value = value.trim();
        await this.plugin.saveSettings();
      }));
  }
}
