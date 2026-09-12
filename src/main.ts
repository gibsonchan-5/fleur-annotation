// 主入口
import { Plugin, WorkspaceLeaf, TFile, Notice, MarkdownView, Menu } from 'obsidian';
import { SidebarView, VIEW_TYPE_FLEUR_NOTE } from './sidebar';
import { MarkdownPatcher } from './patcher';
import { AnnotationStore } from './store';
import { FleurSettings, DEFAULT_SETTINGS, FleurSettingTab, LEGACY_DEFAULT_SYSTEM_PROMPT } from './settings';
import {
  hydrateSecrets,
  scrubSecretsForPersistence,
  secretStorageAvailable,
  migrateSecrets,
  resolveBackend,
  type SecretBackend,
} from './secret-store';

export default class FleurAnnotationPlugin extends Plugin {
  store: AnnotationStore;
  patcher: MarkdownPatcher;
  settings: FleurSettings = DEFAULT_SETTINGS;
  /** 本机 Obsidian 是否支持官方 SecretStorage（系统钥匙串）。 */
  secretStorageAvailable = false;

  /** 当前实际生效的密钥后端（system=钥匙串，vault=data.json 明文）。 */
  get secretBackend(): SecretBackend {
    return resolveBackend(this.app, this.settings.secretStorageMode);
  }

  async onload() {
    await this.loadSettings();

    this.store = new AnnotationStore(this.app, this.manifest.id);
    this.patcher = new MarkdownPatcher(this);
    this.patcher.install();

    this.registerView(VIEW_TYPE_FLEUR_NOTE, (leaf) => {
      return new SidebarView(leaf, this);
    });

    this.addRibbonIcon('feather', 'FleurAnnotation', () => {
      this.activateSidebar();
    });

    this.addCommand({
      id: 'open-sidebar',
      name: '打开批注侧边栏',
      callback: () => this.activateSidebar()
    });

    this.addSettingTab(new FleurSettingTab(this.app, this));

    // Live Preview 右键菜单：追加到原生菜单
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        const selection = editor.getSelection();
        if (!selection || selection.trim().length === 0) return;
        this.patcher.appendMenuItems(menu, selection);
      })
    );

    // 监听文件切换，刷新侧边栏
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file?.extension === 'md') this.refreshSidebar();
      })
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          const file = leaf.view.file;
          if (file?.extension === 'md') this.refreshSidebar();
        }
      })
    );

    // 默认打开侧边栏
    this.app.workspace.onLayoutReady(() => {
      this.activateSidebar();
    });
  }

  onunload() {
    this.patcher?.uninstall();
  }

  async loadSettings() {
    const raw = (await this.loadData()) as (Partial<FleurSettings> & { systemPrompt?: string }) | null;
    const settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});

    // 旧版（≤1.0.8）只有一个 systemPrompt 字段。迁移：
    // 若用户改过（非默认值），迁入「自定义提示词 1」槽并选中 custom-1，避免自定义内容丢失。
    const legacyPrompt = raw?.systemPrompt;
    if (legacyPrompt && legacyPrompt.trim() && legacyPrompt !== LEGACY_DEFAULT_SYSTEM_PROMPT && !raw?.promptPreset) {
      settings.customPrompts = [legacyPrompt.trim(), '', ''];
      settings.promptPreset = 'custom-1';
    }
    // 自定义槽兜底：保证长度恒为 3
    if (!Array.isArray(settings.customPrompts) || settings.customPrompts.length < 3) {
      const list = Array.isArray(settings.customPrompts) ? settings.customPrompts : [];
      settings.customPrompts = [list[0] ?? '', list[1] ?? '', list[2] ?? ''];
    }
    this.settings = settings;

    // API Key 存入系统钥匙串；磁盘上若还留有明文，在这里迁走并清掉。
    // 用户切到 data.json 模式时则反其道行之：文件即真相，不写钥匙串。
    this.secretStorageAvailable = secretStorageAvailable(this.app);
    const secretState = await hydrateSecrets(
      this.app,
      this.settings as unknown as Record<string, unknown>,
      raw as Record<string, unknown> | null,
      this.secretBackend,
    );
    if (secretState.migrated.length > 0) {
      await this.saveSettings();
      new Notice('FleurAnnotation：API Key 已移入系统钥匙串，data.json 中不再保存明文');
    }

    // 用户要求默认按笔记上下文排序：仅一次把旧 time 设置迁移为 line，之后尊重用户选择
    if (this.settings.annotationSort === 'time' && !this.settings.annotationSortMigrated) {
      this.settings.annotationSort = 'line';
      this.settings.annotationSortMigrated = true;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    // 密钥只写系统钥匙串；写盘时从副本里抹掉（钥匙串不可用时保留明文，避免丢密钥）。
    // data.json 模式下原样落盘——明文正是用户的选择。
    await this.saveData(
      await scrubSecretsForPersistence(
        this.app,
        this.settings as unknown as Record<string, unknown>,
        this.secretBackend,
      ),
    );
  }

  /**
   * 切换密钥保存位置并搬迁现有密钥。
   *
   * 搬入钥匙串逐字段校验；任何一步写不进去就回滚到原模式，
   * 宁可维持明文也不丢密钥。
   */
  async setSecretStorageMode(
    mode: 'system' | 'vault',
  ): Promise<{ ok: boolean; failed: string[] }> {
    const previous = this.settings.secretStorageMode;
    const target = resolveBackend(this.app, mode);

    this.settings.secretStorageMode = mode;
    const result = await migrateSecrets(
      this.app,
      this.settings as unknown as Record<string, unknown>,
      target,
    );

    if (!result.ok) {
      this.settings.secretStorageMode = previous;
      await this.saveSettings();
      return { ok: false, failed: [...result.failed] };
    }

    await this.saveSettings();
    return { ok: true, failed: [] };
  }

  async activateSidebar() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_FLEUR_NOTE)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({ type: VIEW_TYPE_FLEUR_NOTE, active: true });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  refreshSidebar() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FLEUR_NOTE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view && typeof (view as any).refreshAnnotations === 'function') {
        (view as any).refreshAnnotations();
      }
    }
  }

  generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}
