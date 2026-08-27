import {
  App,
  FuzzySuggestModal,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

const VIEW_TYPE = "one-minute-english-view";
type TopicStatus = "editing" | "completed" | "published";

interface FolderTab {
  id: string;
  name: string;
  path: string;
}

interface OneMinuteEnglishSettings {
  materialFolder: string;
  topicFolder: string;
  statusProperty: string;
  editingValue: string;
  completedValue: string;
  publishedValue: string;
  customTabs: FolderTab[];
}

const DEFAULT_SETTINGS: OneMinuteEnglishSettings = {
  materialFolder: "",
  topicFolder: "",
  statusProperty: "",
  editingValue: "编辑中",
  completedValue: "已完成",
  publishedValue: "已发布",
  customTabs: [],
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

export default class OneMinuteEnglishPlugin extends Plugin {
  settings: OneMinuteEnglishSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new OneMinuteEnglishView(leaf, this));
    this.addRibbonIcon("languages", "打开 One Minute English", () => void this.activateView());
    this.addCommand({ id: "open-one-minute-english", name: "打开主页", callback: () => void this.activateView() });
    this.addSettingTab(new OneMinuteEnglishSettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof OneMinuteEnglishView) view.render();
    });
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
      text: "全部",
    });
    allButton.addEventListener("click", () => {
      this.activeStatus = null;
      this.render();
    });
    this.statusButton(tags, "editing", "编辑中");
    this.statusButton(tags, "completed", "已完成");
    this.statusButton(tags, "published", "已发布");

    let files = this.filesInFolder(this.plugin.settings.topicFolder);
    if (this.activeStatus) files = this.filterByStatus(files, this.activeStatus, true);
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
    containerEl.createEl("p", { cls: "setting-item-description", text: "目录路径均相对于当前 Obsidian 库；列表会自动包含所有子目录中的 Markdown 文档。" });
    this.folderSetting("素材目录", "主页“素材”标签加载的目录。", "materialFolder");
    this.folderSetting("话题目录", "右侧“话题列表”加载的目录。", "topicFolder");
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

  private folderSetting(name: string, description: string, key: "materialFolder" | "topicFolder"): void {
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
