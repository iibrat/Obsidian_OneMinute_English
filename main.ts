import {
  App,
  Editor,
  FuzzySuggestModal,
  ItemView,
  MarkdownFileInfo,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";

const VIEW_TYPE = "one-minute-english-view";
const HIGHLIGHTS_VIEW_TYPE = "one-minute-english-highlights-view";
const HIGHLIGHTS_LIBRARY_VIEW_TYPE = "one-minute-english-highlights-library-view";
type TopicStatus = "editing" | "completed" | "published";

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
}

interface FolderTab {
  id: string;
  name: string;
  path: string;
}

interface OneMinuteEnglishSettings {
  openAsStartupPage: boolean;
  materialFolder: string;
  topicFolder: string;
  statusProperty: string;
  editingValue: string;
  completedValue: string;
  publishedValue: string;
  quickCaptureFolder: string;
  quickCaptureFilenameFormat: string;
  customTabs: FolderTab[];
  highlights: HighlightNote[];
}

const DEFAULT_SETTINGS: OneMinuteEnglishSettings = {
  openAsStartupPage: false,
  materialFolder: "",
  topicFolder: "",
  statusProperty: "",
  editingValue: "编辑中",
  completedValue: "已完成",
  publishedValue: "已发布",
  quickCaptureFolder: "",
  quickCaptureFilenameFormat: "",
  customTabs: [],
  highlights: [],
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

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new OneMinuteEnglishView(leaf, this));
    this.registerView(HIGHLIGHTS_VIEW_TYPE, (leaf) => new HighlightsView(leaf, this));
    this.registerView(HIGHLIGHTS_LIBRARY_VIEW_TYPE, (leaf) => new HighlightsLibraryView(leaf, this));
    this.addRibbonIcon("languages", "打开 One Minute English", () => void this.activateView());
    this.addRibbonIcon("highlighter", "打开高亮侧栏", () => void this.activateHighlightsView());
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
    this.addCommand({ id: "open-highlights-library", name: "打开高亮总览", callback: () => void this.activateHighlightsLibraryView() });
    this.registerDomEvent(document, "mouseup", (event) => {
      if (this.selectionButton?.contains(event.target as Node)) return;
      window.setTimeout(() => this.updateSelectionButton(), 0);
    });
    this.registerDomEvent(document, "keyup", () => window.setTimeout(() => this.updateSelectionButton(), 0));
    this.registerDomEvent(document, "mousedown", (event) => {
      if (!this.selectionButton?.contains(event.target as Node)) this.hideSelectionButton();
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.hideSelectionButton()));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.updateHighlightPaths(file.path, oldPath)));
    this.addSettingTab(new OneMinuteEnglishSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openAsStartupPage) void this.activateView();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => void this.openInEmptyLeaf()));
  }

  onunload(): void {
    this.hideSelectionButton();
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

  async activateHighlightsLibraryView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(HIGHLIGHTS_LIBRARY_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: HIGHLIGHTS_LIBRARY_VIEW_TYPE, active: true });
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
    const body = note ? `${highlight.text}\n\n## 补充内容\n\n${note}` : highlight.text;
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
  }

  private async updateHighlightPaths(newPath: string, oldPath: string): Promise<void> {
    let changed = false;
    this.settings.highlights.forEach((highlight) => {
      if (highlight.sourcePath === oldPath || highlight.sourcePath.startsWith(`${oldPath}/`)) {
        highlight.sourcePath = `${newPath}${highlight.sourcePath.slice(oldPath.length)}`;
        changed = true;
      }
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.highlights)) this.settings.highlights = [];
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof OneMinuteEnglishView) view.render();
    });
    this.app.workspace.getLeavesOfType(HIGHLIGHTS_VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof HighlightsView) view.render();
    });
    this.app.workspace.getLeavesOfType(HIGHLIGHTS_LIBRARY_VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof HighlightsLibraryView) view.render();
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
    const openLibrary = heading.createEl("button", {
      cls: "ome-open-highlights-library",
      attr: { "aria-label": "打开高亮总览", title: "打开高亮总览" },
    });
    setIcon(openLibrary, "library");
    openLibrary.addEventListener("click", () => void this.plugin.activateHighlightsLibraryView());
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
    textarea.value = highlight.note;
    textarea.addEventListener("input", () => { highlight.note = textarea.value; });
    textarea.addEventListener("blur", () => void this.plugin.saveSettings());
    textarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        textarea.blur();
      }
    });

    const actions = card.createDiv({ cls: "ome-highlight-card-actions" });
    const createNote = actions.createEl("button", {
      cls: "ome-highlight-create-note",
      attr: { "aria-label": "将高亮转为笔记", title: "将高亮转为笔记" },
    });
    setIcon(createNote, "file-plus-2");
    createNote.addEventListener("click", () => void this.plugin.convertHighlightToNote(highlight));
    const remove = actions.createEl("button", {
      cls: "ome-highlight-delete",
      attr: { "aria-label": "删除高亮", title: "删除高亮" },
    });
    setIcon(remove, "trash-2");
    remove.addEventListener("click", () => this.plugin.requestDeleteHighlight(highlight));
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

class HighlightsLibraryView extends HighlightsView {
  private selectedPath = "";

  getViewType(): string { return HIGHLIGHTS_LIBRARY_VIEW_TYPE; }
  getDisplayText(): string { return "高亮总览"; }
  getIcon(): string { return "library"; }

  async onOpen(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    this.selectedPath = activeFile?.path ?? "";
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ome-highlights-library");

    const summaries = Array.from(this.plugin.settings.highlights.reduce((items, highlight) => {
      const current = items.get(highlight.sourcePath);
      if (current) {
        current.count += 1;
        current.latest = Math.max(current.latest, highlight.createdAt);
      } else {
        items.set(highlight.sourcePath, { path: highlight.sourcePath, count: 1, latest: highlight.createdAt });
      }
      return items;
    }, new Map<string, { path: string; count: number; latest: number }>()).values())
      .sort((a, b) => b.latest - a.latest);

    if (!summaries.some((summary) => summary.path === this.selectedPath)) {
      this.selectedPath = summaries[0]?.path ?? "";
    }

    const header = root.createDiv({ cls: "ome-highlights-library-header" });
    const headerIcon = header.createSpan();
    setIcon(headerIcon, "library");
    header.createEl("h2", { text: "高亮总览" });
    header.createSpan({ cls: "ome-count", text: String(this.plugin.settings.highlights.length) });

    const columns = root.createDiv({ cls: "ome-highlights-library-columns" });
    const notes = columns.createDiv({ cls: "ome-highlight-note-list" });
    const cards = columns.createDiv({ cls: "ome-highlight-library-cards" });

    if (!summaries.length) {
      notes.createDiv({ cls: "ome-highlight-library-empty", text: "还没有包含高亮的笔记" });
      return;
    }

    summaries.forEach((summary) => {
      const button = notes.createEl("button", {
        cls: `ome-highlight-note-item${summary.path === this.selectedPath ? " is-active" : ""}`,
        attr: { title: summary.path },
      });
      const name = summary.path.split("/").pop()?.replace(/\.md$/i, "") ?? summary.path;
      button.createSpan({ cls: "ome-highlight-note-name", text: name });
      button.createSpan({ cls: "ome-count", text: String(summary.count) });
      if (summary.path.includes("/")) {
        button.createSpan({ cls: "ome-highlight-note-path", text: summary.path.slice(0, summary.path.lastIndexOf("/")) });
      }
      button.addEventListener("click", () => {
        this.selectedPath = summary.path;
        this.render();
      });
    });

    const selectedHighlights = this.plugin.settings.highlights.filter(
      (highlight) => highlight.sourcePath === this.selectedPath,
    );
    const selectedName = this.selectedPath.split("/").pop()?.replace(/\.md$/i, "") ?? this.selectedPath;
    const cardsHeader = cards.createDiv({ cls: "ome-highlight-library-cards-header" });
    cardsHeader.createEl("h3", { text: selectedName });
    cardsHeader.createSpan({ cls: "ome-count", text: String(selectedHighlights.length) });
    const list = cards.createDiv({ cls: "ome-highlight-list" });
    selectedHighlights.forEach((highlight) => this.renderHighlight(list, highlight));
  }
}

class OneMinuteEnglishView extends ItemView {
  private activeTabId = "materials";
  private activeStatus: TopicStatus | null = null;
  private query = "";

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
    this.renderHeader(root);
    this.renderStats(root);
    const columns = root.createDiv({ cls: "ome-columns" });
    this.renderMaterials(columns.createDiv({ cls: "ome-panel ome-material-panel" }));
    this.renderTopics(columns.createDiv({ cls: "ome-panel ome-topic-panel" }));
    root.createDiv({ cls: "ome-bottom-spacer", attr: { "aria-hidden": "true" } });
    this.renderQuickCaptureButton(root);
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
    const formatted = this.formatDate(new Date(), this.plugin.settings.quickCaptureFilenameFormat);
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

  private formatDate(date: Date, format: string): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    const values: Record<string, string> = {
      YYYY: String(date.getFullYear()),
      YY: String(date.getFullYear()).slice(-2),
      MM: pad(date.getMonth() + 1),
      M: String(date.getMonth() + 1),
      dd: pad(date.getDate()),
      d: String(date.getDate()),
      HH: pad(date.getHours()),
      H: String(date.getHours()),
      mm: pad(date.getMinutes()),
      m: String(date.getMinutes()),
      ss: pad(date.getSeconds()),
      s: String(date.getSeconds()),
    };
    return format.replace(/YYYY|YY|MM|M|dd|d|HH|H|mm|m|ss|s/g, (token) => values[token]);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "ome-header" });
    const brand = header.createDiv({ cls: "ome-brand" });
    const logo = brand.createSpan({ cls: "ome-brand-icon" });
    setIcon(logo, "layers-3");
    brand.createEl("h1", { text: "One Minute English" });
    const searchWrap = header.createDiv({ cls: "ome-search" });
    const searchIcon = searchWrap.createSpan();
    setIcon(searchIcon, "search");
    const input = searchWrap.createEl("input", { type: "search", placeholder: "搜索素材或话题…", value: this.query });
    input.addEventListener("input", () => {
      this.query = input.value;
      this.render();
      const nextInput = this.contentEl.querySelector<HTMLInputElement>(".ome-search input");
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(this.query.length, this.query.length);
      }
    });
    const settings = header.createEl("button", { cls: "ome-icon-button", attr: { "aria-label": "打开设置" } });
    setIcon(settings, "settings");
    settings.addEventListener("click", () => {
      const appWithSettings = this.app as App & { setting: { open(): void; openTabById(id: string): void } };
      appWithSettings.setting.open();
      appWithSettings.setting.openTabById(this.plugin.manifest.id);
    });
  }

  private renderStats(root: HTMLElement): void {
    const materialFiles = this.filesInFolder(this.plugin.settings.materialFolder);
    const topicFiles = this.filesInFolder(this.plugin.settings.topicFolder);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const abandonedTopics = topicFiles.filter((file) => file.stat.mtime < sevenDaysAgo).length;
    const stats = root.createDiv({ cls: "ome-stats" });
    this.statCard(stats, "files", materialFiles.length, "素材数量");
    this.statCard(stats, "message-square-text", topicFiles.length, "话题数量");
    this.statCard(stats, "clock-alert", abandonedTopics, "荒废话题", true);
  }

  private statCard(parent: HTMLElement, iconName: string, value: number, label: string, danger = false): void {
    const card = parent.createDiv({ cls: `ome-stat-card${danger ? " is-danger" : ""}` });
    const icon = card.createSpan({ cls: "ome-stat-icon" });
    setIcon(icon, iconName);
    const copy = card.createDiv();
    copy.createDiv({ cls: "ome-stat-value", text: String(value) });
    copy.createDiv({ cls: "ome-stat-label", text: label });
  }

  private renderMaterials(panel: HTMLElement): void {
    const tabs = panel.createDiv({ cls: "ome-tabs" });
    this.renderTab(tabs, { id: "materials", name: "素材", path: this.plugin.settings.materialFolder }, false);
    this.plugin.settings.customTabs.forEach((tab) => this.renderTab(tabs, tab, true));
    const add = tabs.createEl("button", { cls: "ome-tab-add", attr: { "aria-label": "添加目录标签" } });
    setIcon(add, "plus");
    add.addEventListener("click", () => {
      new FolderSuggestModal(this.app, (folder) => void this.addFolderTab(folder)).open();
    });

    const selected = this.activeTabId === "materials"
      ? { id: "materials", name: "素材", path: this.plugin.settings.materialFolder }
      : this.plugin.settings.customTabs.find((tab) => tab.id === this.activeTabId) ?? { id: "materials", name: "素材", path: this.plugin.settings.materialFolder };
    const body = panel.createDiv({ cls: "ome-panel-body" });
    const title = body.createDiv({ cls: "ome-panel-title" });
    const titleIcon = title.createSpan();
    setIcon(titleIcon, "folder-open");
    title.createEl("h2", { text: selected.name });
    const files = this.searchFiles(this.filesInFolder(selected.path));
    title.createSpan({ cls: "ome-count", text: String(files.length) });
    this.renderFileList(body, files, "该目录中没有 Markdown 文档");
  }

  private renderTab(parent: HTMLElement, tab: FolderTab, removable: boolean): void {
    const button = parent.createEl("button", { cls: `ome-tab${this.activeTabId === tab.id ? " is-active" : ""}` });
    button.createSpan({ text: tab.name });
    button.addEventListener("click", () => { this.activeTabId = tab.id; this.render(); });
    if (removable) {
      const remove = button.createSpan({ cls: "ome-tab-remove", attr: { "aria-label": `删除 ${tab.name}` } });
      setIcon(remove, "x");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.removeFolderTab(tab.id);
      });
    }
  }

  private async addFolderTab(folder: TFolder): Promise<void> {
    if (this.plugin.settings.customTabs.some((tab) => tab.path === folder.path)) {
      new Notice("这个目录已经添加过了");
      return;
    }
    const tab: FolderTab = { id: `${Date.now()}-${folder.path}`, name: folder.name, path: folder.path };
    this.plugin.settings.customTabs.push(tab);
    this.activeTabId = tab.id;
    await this.plugin.saveSettings();
  }

  private async removeFolderTab(id: string): Promise<void> {
    this.plugin.settings.customTabs = this.plugin.settings.customTabs.filter((tab) => tab.id !== id);
    if (this.activeTabId === id) this.activeTabId = "materials";
    await this.plugin.saveSettings();
  }

  private renderTopics(panel: HTMLElement): void {
    const heading = panel.createDiv({ cls: "ome-topic-heading" });
    const title = heading.createDiv({ cls: "ome-panel-title" });
    const icon = title.createSpan();
    setIcon(icon, "list-todo");
    title.createEl("h2", { text: "话题列表" });
    const tags = heading.createDiv({ cls: "ome-status-tags" });
    const allButton = tags.createEl("button", {
      cls: `ome-status-tag${this.activeStatus === null ? " is-active" : ""}`,
      text: "未编辑",
    });
    allButton.addEventListener("click", () => {
      this.activeStatus = null;
      this.render();
    });
    this.statusButton(tags, "editing", "编辑中");
    this.statusButton(tags, "completed", "已完成");
    this.statusButton(tags, "published", "已发布");

    let files = this.filesInFolder(this.plugin.settings.topicFolder);
    files = this.activeStatus
      ? this.filterByStatus(files, this.activeStatus, true)
      : this.filterUnedited(files);
    files = this.searchFiles(files);
    title.createSpan({ cls: "ome-count", text: String(files.length) });
    this.renderFileList(panel, files, "没有符合条件的话题");
  }

  private statusButton(parent: HTMLElement, status: TopicStatus, text: string): void {
    const button = parent.createEl("button", { cls: `ome-status-tag ome-status-${status}${this.activeStatus === status ? " is-active" : ""}`, text });
    button.addEventListener("click", () => {
      if (!this.hasStatusConfiguration(status)) {
        new Notice(`请先在 One Minute English 设置中配置“状态属性”和“${text}”对应值`);
        return;
      }
      this.activeStatus = this.activeStatus === status ? null : status;
      this.render();
    });
  }

  private renderFileList(parent: HTMLElement, files: TFile[], emptyText: string): void {
    const list = parent.createDiv({ cls: "ome-file-list" });
    if (!files.length) {
      const empty = list.createDiv({ cls: "ome-empty" });
      const icon = empty.createSpan();
      setIcon(icon, "file-search");
      empty.createDiv({ text: emptyText });
      return;
    }
    files.sort((a, b) => b.stat.mtime - a.stat.mtime).forEach((file) => {
      const row = list.createDiv({ cls: "ome-file-row" });
      const fileIcon = row.createSpan({ cls: "ome-file-icon" });
      setIcon(fileIcon, "file-text");
      const details = row.createDiv({ cls: "ome-file-details" });
      details.createDiv({ cls: "ome-file-name", text: file.basename });
      const meta = details.createDiv({ cls: "ome-file-meta" });
      meta.createSpan({ text: this.relativeTime(file.stat.mtime) });
      meta.createSpan({ cls: "ome-md-badge", text: ".md" });
      const folder = file.parent?.path && file.parent.path !== "/" ? file.parent.path : "根目录";
      meta.createSpan({ text: folder });
      const open = row.createEl("button", { cls: "ome-open-file", attr: { "aria-label": `打开 ${file.basename}` } });
      setIcon(open, "square-pen");
      const openFile = () => void this.app.workspace.getLeaf(false).openFile(file);
      row.addEventListener("click", openFile);
      open.addEventListener("click", (event) => { event.stopPropagation(); openFile(); });
    });
  }

  private filesInFolder(folderPath: string): TFile[] {
    if (!folderPath) return [];
    const normalized = folderPath.replace(/^\/+|\/+$/g, "");
    return this.app.vault.getMarkdownFiles().filter((file) => file.path === normalized || file.path.startsWith(`${normalized}/`));
  }

  private searchFiles(files: TFile[]): TFile[] {
    const query = this.query.trim().toLocaleLowerCase();
    if (!query) return files;
    return files.filter((file) => file.basename.toLocaleLowerCase().includes(query) || file.path.toLocaleLowerCase().includes(query));
  }

  private hasStatusConfiguration(status: TopicStatus): boolean {
    return Boolean(this.plugin.settings.statusProperty.trim() && this.statusValue(status).trim());
  }

  private statusValue(status: TopicStatus): string {
    if (status === "editing") return this.plugin.settings.editingValue;
    if (status === "completed") return this.plugin.settings.completedValue;
    return this.plugin.settings.publishedValue;
  }

  private filterByStatus(files: TFile[], status: TopicStatus, warn: boolean): TFile[] {
    if (!this.hasStatusConfiguration(status)) {
      if (warn) new Notice("请先配置用于区分话题状态的文档属性");
      return [];
    }
    const property = this.plugin.settings.statusProperty;
    const expected = this.statusValue(status).toLocaleLowerCase();
    return files.filter((file) => {
      const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[property];
      if (Array.isArray(value)) return value.some((item) => String(item).toLocaleLowerCase() === expected);
      return value !== undefined && String(value).toLocaleLowerCase() === expected;
    });
  }

  private filterUnedited(files: TFile[]): TFile[] {
    const property = this.plugin.settings.statusProperty.trim() || "状态";
    return files.filter((file) => {
      const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[property];
      if (value === undefined || value === null) return true;
      if (Array.isArray(value)) {
        return value.length === 0 || value.some((item) => {
          const normalized = String(item ?? "").trim().toLocaleLowerCase();
          return normalized === "" || normalized === "未处理";
        });
      }
      const normalized = String(value).trim().toLocaleLowerCase();
      return normalized === "" || normalized === "未处理";
    });
  }

  private relativeTime(timestamp: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return "刚刚";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return new Date(timestamp).toLocaleDateString("zh-CN");
  }
}

class OneMinuteEnglishSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: OneMinuteEnglishPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "One Minute English 设置" });
    new Setting(containerEl)
      .setName("设为启动页面")
      .setDesc("Obsidian 启动或所有标签页关闭后，自动显示 One Minute English 主页。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.openAsStartupPage).onChange(async (value) => {
        this.plugin.settings.openAsStartupPage = value;
        await this.plugin.saveSettings();
        if (value) await this.plugin.activateView();
      }));
    containerEl.createEl("p", { cls: "setting-item-description", text: "目录路径均相对于当前 Obsidian 库；列表会自动包含所有子目录中的 Markdown 文档。" });
    this.folderSetting("素材目录", "主页“素材”标签加载的目录。", "materialFolder");
    this.folderSetting("话题目录", "右侧“话题列表”加载的目录。", "topicFolder");
    this.folderSetting("快速记录目录", "右下角 + 按钮创建的 Markdown 文档保存到这里。", "quickCaptureFolder");
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
    this.valueSetting("“编辑中”对应值", "editingValue", "编辑中");
    this.valueSetting("“已完成”对应值", "completedValue", "已完成");
    this.valueSetting("“已发布”对应值", "publishedValue", "已发布");
  }

  private folderSetting(name: string, description: string, key: "materialFolder" | "topicFolder" | "quickCaptureFolder"): void {
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

  private valueSetting(name: string, key: "editingValue" | "completedValue" | "publishedValue", placeholder: string): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc("该属性为此值时归入对应标签；也支持属性值为列表。")
      .addText((text) => text.setPlaceholder(placeholder).setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value.trim();
        await this.plugin.saveSettings();
      }));
  }
}
