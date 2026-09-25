// 主入口
import { Plugin, WorkspaceLeaf, TFile, TFolder, TAbstractFile, Notice, MarkdownView, Menu, Platform } from 'obsidian';
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

    this.store = new AnnotationStore(this.app, this.manifest.id, () => this.settings);
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

    // 监听文件重命名/移动，让批注数据跟随迁移
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        void this.handleRename(file, oldPath);
      })
    );

    // 笔记被删除 → 对应批注 sidecar 一并清理（否则成为孤儿，全量体检时发现的存量问题）
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        void this.handleDelete(file);
      })
    );

    // 默认打开侧边栏（移动端侧边栏会占满整屏，不自动打开，避免启动即被覆盖）
    this.app.workspace.onLayoutReady(() => {
      if (!Platform.isMobile) this.activateSidebar();
      void this.migrateToVaultDir();
    });
  }

  /**
   * 开启「跨设备同步批注数据」后的一次性迁移：把配置目录里的存量 sidecar
   * （hash 文件名）搬进 Vault 同步目录（真实路径镜像），按 fileId 对齐、并集合并。
   * 幂等：以 settings.annotationsSyncMigrated 为标记，新文件已存在时合并语义天然安全。
   * 旧文件保留不删——回滚到关闭开关时数据仍在。
   */
  private async migrateToVaultDir(): Promise<void> {
    if (!this.settings.syncAnnotationsToVault || this.settings.annotationsSyncMigrated) return;
    try {
      const sidecars = await this.store.listLegacySidecars();
      let moved = 0;
      for (const { fileId } of sidecars) {
        const data = await this.store.load(fileId);
        // load 走的是新目录（同步模式已开启）；旧文件里的存量数据并集合并进去
        const legacy = await this.store.legacyData(fileId);
        if (!legacy) continue;
        const before = data.annotations.length + (data.aiResults?.length ?? 0);
        const ids = new Set(data.annotations.map(a => a.id));
        for (const a of legacy.annotations ?? []) {
          if (!ids.has(a.id)) {
            data.annotations.push(a);
            ids.add(a.id);
            moved++;
          }
        }
        const rids = new Set((data.aiResults ?? []).map(r => r.id));
        for (const r of legacy.aiResults ?? []) {
          if (!rids.has(r.id)) {
            (data.aiResults ??= []).push(r);
            rids.add(r.id);
            moved++;
          }
        }
        const after = data.annotations.length + (data.aiResults?.length ?? 0);
        if (after > before || before === 0) await this.store.save(data);
      }
      this.settings.annotationsSyncMigrated = true;
      await this.saveSettings();
      if (moved > 0) new Notice(`FleurAnnotation：已迁移 ${moved} 条批注到同步目录`);
    } catch (e) {
      console.error('FleurAnnotation: 批注数据迁移到同步目录失败', e);
    }
  }

  /** 笔记删除时清理其批注 sidecar（两种模式下都删，避免孤儿堆积） */
  private async handleDelete(file: TAbstractFile): Promise<void> {
    try {
      if (file instanceof TFile && file.extension === 'md') {
        await this.store.deleteSidecar(file.path);
      }
    } catch (e) {
      console.error('FleurAnnotation: 清理批注数据失败', file.path, e);
    }
  }

  /** 批注数据按路径键控，文件移动/重命名时同步迁移，避免批注与文件失联。 */
  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    try {
      let moved = 0;
      if (file instanceof TFolder) {
        moved = await this.store.migrateFolder(oldPath, file.path);
      } else if (file instanceof TFile && file.extension === 'md') {
        moved = await this.store.migratePath(oldPath, file.path);
      }
      if (moved > 0) {
        new Notice(`FleurAnnotation：批注已跟随移动（${moved} 条）`);
        // 若移动的正是当前打开的文件，刷新侧边栏加载迁移后的数据
        const active = this.app.workspace.getActiveFile();
        if (active && (active.path === file.path || active.path.startsWith(file.path + '/'))) {
          this.refreshSidebar();
        }
      }
    } catch (e) {
      console.error('FleurAnnotation: 批注迁移失败', oldPath, e);
    }
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
