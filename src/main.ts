// 主入口
import { Plugin, WorkspaceLeaf, TFile, Notice, MarkdownView, Menu } from 'obsidian';
import { SidebarView, VIEW_TYPE_FLEUR_NOTE } from './sidebar';
import { MarkdownPatcher } from './patcher';
import { AnnotationStore } from './store';
import { FleurSettings, DEFAULT_SETTINGS, FleurSettingTab } from './settings';

export default class FleurAnnotationPlugin extends Plugin {
  store: AnnotationStore;
  patcher: MarkdownPatcher;
  settings: FleurSettings = DEFAULT_SETTINGS;

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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // 用户要求默认按笔记上下文排序：仅一次把旧 time 设置迁移为 line，之后尊重用户选择
    if (this.settings.annotationSort === 'time' && !this.settings.annotationSortMigrated) {
      this.settings.annotationSort = 'line';
      this.settings.annotationSortMigrated = true;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
