// Markdown 编辑器拦截 + 右键菜单 + 侵入式编辑
// 支持 Live Preview 模式和 Reading Mode
import { Menu, MarkdownView, Notice, Modal, TFile } from 'obsidian';
import type { Editor } from 'obsidian';
import type FleurAnnotationPlugin from './main';
import { AIChatPanel } from './ai-chat-modal';
import { wrapSelection, appendToSelection, findAndReplace, getReadingModeSelection, isInReadingMode, isInLivePreview, stripMarkdown, escapeRegex } from './editor';

/** 自定义批注输入弹窗 */
class CommentModal extends Modal {
  private textarea: HTMLTextAreaElement;
  private onConfirm: (text: string) => void;

  constructor(
    plugin: FleurAnnotationPlugin,
    private previewText: string,
    onConfirm: (text: string) => void
  ) {
    super(plugin.app);
    this.onConfirm = onConfirm;
  }

  onOpen() {
    // 给 modal 容器加自定义 class，用于控制宽度
    const modalEl = this.modalEl;
    modalEl.addClass('fleur-annotation-comment-modal');

    const { contentEl } = this;
    contentEl.empty();

    // 标题
    const titleEl = contentEl.createEl('h3', { text: '添加批注' });
    titleEl.style.cssText = `
      margin: 0 0 16px 0; font-size: 18px; font-weight: 600;
      color: var(--text-normal); letter-spacing: -0.01em;
    `;

    // 选中文本预览
    const label = contentEl.createDiv({ text: '选中文本' });
    label.style.cssText = `
      font-size: 11px; font-weight: 500; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--text-faint);
      margin-bottom: 6px;
    `;

    const preview = contentEl.createDiv();
    preview.style.cssText = `
      font-size: 13px; line-height: 1.6;
      color: var(--text-muted);
      background: var(--background-secondary);
      border-left: 3px solid var(--interactive-accent);
      padding: 10px 14px; border-radius: 0 6px 6px 0;
      margin-bottom: 20px;
      max-height: 120px; overflow-y: auto;
    `;
    preview.textContent = this.previewText;

    // 批注输入
    const inputLabel = contentEl.createDiv({ text: '批注内容' });
    inputLabel.style.cssText = `
      font-size: 11px; font-weight: 500; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--text-faint);
      margin-bottom: 6px;
    `;

    this.textarea = contentEl.createEl('textarea');
    this.textarea.placeholder = '写下你的想法…';
    this.textarea.style.cssText = `
      width: 100%; min-height: 120px;
      padding: 12px 14px;
      border: 1px solid var(--background-modifier-border);
      border-radius: 8px;
      background: var(--background-primary);
      color: var(--text-normal);
      font-size: 14px; line-height: 1.6;
      resize: vertical;
      font-family: inherit;
      box-sizing: border-box;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    `;
    this.textarea.addEventListener('focus', () => {
      this.textarea.style.borderColor = 'var(--interactive-accent)';
      this.textarea.style.boxShadow = '0 0 0 2px var(--interactive-accent-hover, rgba(99,102,241,0.15))';
    });
    this.textarea.addEventListener('blur', () => {
      this.textarea.style.borderColor = 'var(--background-modifier-border)';
      this.textarea.style.boxShadow = 'none';
    });

    // 按钮行
    const btnRow = contentEl.createDiv();
    btnRow.style.cssText = `
      display: flex; gap: 10px; justify-content: flex-end;
      margin-top: 20px; padding-top: 16px;
      border-top: 1px solid var(--background-modifier-border);
    `;

    const cancelBtn = btnRow.createEl('button', { text: '取消' });
    cancelBtn.style.cssText = `
      padding: 8px 20px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--background-modifier-border);
      background: transparent;
      color: var(--text-muted); font-size: 14px; font-weight: 500;
      transition: all 0.15s ease;
    `;
    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.background = 'var(--background-modifier-hover)';
      cancelBtn.style.color = 'var(--text-normal)';
    });
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.background = 'transparent';
      cancelBtn.style.color = 'var(--text-muted)';
    });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = btnRow.createEl('button', { text: '确定' });
    confirmBtn.style.cssText = `
      padding: 8px 20px; border-radius: 8px; cursor: pointer;
      border: none;
      background: var(--interactive-accent);
      color: var(--text-on-accent); font-size: 14px; font-weight: 500;
      transition: all 0.15s ease;
    `;
    confirmBtn.addEventListener('mouseenter', () => {
      confirmBtn.style.opacity = '0.9';
      confirmBtn.style.transform = 'translateY(-1px)';
    });
    confirmBtn.addEventListener('mouseleave', () => {
      confirmBtn.style.opacity = '1';
      confirmBtn.style.transform = 'translateY(0)';
    });
    confirmBtn.addEventListener('click', () => {
      const text = this.textarea.value.trim();
      if (!text) return;
      this.close();
      this.onConfirm(text);
    });

    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        confirmBtn.click();
      }
    });

    setTimeout(() => this.textarea.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class MarkdownPatcher {
  private boundContextMenu: ((e: MouseEvent) => void) | null = null;
  private boundClick: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: ((e: MouseEvent) => void) | null = null;

  /** 当前悬浮的气泡 */
  private tooltipEl: HTMLElement | null = null;
  /** 当前气泡的隐藏定时器 */
  private tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;

  /** DOM 变更观察器，用于注入批注气泡 */
  private observer: MutationObserver | null = null;
  /** 注入 debounce 定时器 */
  private injectTimer: ReturnType<typeof setTimeout> | null = null;

  /** 保存最近一次选中的文本（用于右键菜单） */
  private lastSelection: string | null = null;

  constructor(private plugin: FleurAnnotationPlugin) {}

  install() {
    this.boundContextMenu = (e: MouseEvent) => this.onContextMenu(e);
    this.boundClick = (e: MouseEvent) => this.onClick(e);
    this.boundMouseUp = (e: MouseEvent) => this.onMouseUp(e);

    document.addEventListener('contextmenu', this.boundContextMenu, true);
    document.addEventListener('click', this.boundClick, true);
    document.addEventListener('mouseup', this.boundMouseUp, true);

    // MutationObserver 监听 DOM 变化，debounce 后注入批注气泡（用于 Live Preview）
    this.observer = new MutationObserver(() => this.scheduleInject());
    this.observer.observe(document.body, { childList: true, subtree: true });

    // 注册 MarkdownPostProcessor，用于阅读模式渲染后注入气泡
    this.plugin.registerMarkdownPostProcessor((el) => {
      // 延迟执行，确保 DOM 已完全渲染
      setTimeout(() => this.injectCommentBubbles(), 50);
    });


  }

  uninstall() {
    if (this.boundContextMenu) document.removeEventListener('contextmenu', this.boundContextMenu, true);
    if (this.boundClick) document.removeEventListener('click', this.boundClick, true);
    if (this.boundMouseUp) document.removeEventListener('mouseup', this.boundMouseUp, true);
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    if (this.injectTimer) clearTimeout(this.injectTimer);
    this.removeTooltip();
  }

  /** debounce 300ms 后注入气泡 */
  private scheduleInject() {
    if (this.injectTimer) clearTimeout(this.injectTimer);
    this.injectTimer = setTimeout(() => this.injectCommentBubbles(), 300);
  }

  /** 主动触发注入（供外部调用，如批注增删后） */
  async forceInject() {
    await this.injectCommentBubbles();
  }

  /**
   * 统一注入批注气泡：同时处理 Live Preview（.cm-content）和 Reading Mode（.markdown-preview-view）
   * 查找所有 <mark> 元素，匹配批注数据后注入 data-fleur-annotation 属性 + 小气泡图标
   */
  private async injectCommentBubbles() {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;

    const data = await this.plugin.store.load(file.path);
    // 查找所有有 comment 字段的批注（不只是 type === 'comment'，高亮也可能有批注）
    const commentAnnotations = data.annotations.filter(a => a.comment);

    if (commentAnnotations.length === 0) return;

    // 查找编辑模式和阅读模式的所有 mark 元素
    const containers = document.querySelectorAll('.cm-content, .markdown-preview-view');

    let injected = 0;

    // 归一化文本用于匹配
    const normalize = (s: string) => s.replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF]+/g, '').toLowerCase();

    containers.forEach(container => {
      // Reading Mode: <mark> / <u>；Live Preview: <mark> / .cm-highlight / <u>
      const marks = container.querySelectorAll('mark, .cm-highlight, u[style], u:not([style])');

      marks.forEach(mark => {
        // 跳过非 annotation 来源的 <u>（如正文自带的下划线）
        const tag = mark.tagName.toLowerCase();
        if (tag === 'u') {
          const isFleurUnderline = commentAnnotations.some(a => {
            if (a.type !== 'underline') return false;
            const aText = normalize(a.text?.trim() || '');
            return aText === normalize(mark.textContent || '') ||
                   aText.includes(normalize(mark.textContent || '')) ||
                   normalize(mark.textContent || '').includes(aText);
          });
          if (!isFleurUnderline) return;
        }

        const rawText = mark.textContent || '';
        const normalizedText = normalize(rawText);


        const annotation = commentAnnotations.find(a => {
          const aText = a.text?.trim();
          if (!aText) return false;
          const normalizedAText = normalize(aText);
          const match = normalizedText === normalizedAText ||
                 normalizedText.includes(normalizedAText) ||
                 normalizedAText.includes(normalizedText);
          if (match) {

          }
          return match;
        });
        if (!annotation) {

          return;
        }

        const markEl = mark as HTMLElement;
        // 已注入过则跳过
        if (markEl.dataset.fleurAnnotation) {

          return;
        }

        markEl.dataset.fleurAnnotation = annotation.id;
        markEl.style.cursor = 'pointer';

        // 创建小气泡图标
        const bubble = document.createElement('span');
        bubble.className = 'fleur-annotation-bubble';
        bubble.dataset.fleurAnnotation = annotation.id;
        bubble.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
        bubble.style.cssText = 'display:inline;font-size:11px;margin-left:2px;cursor:pointer;vertical-align:super;line-height:1;opacity:0.55;transition:opacity 0.15s;';
        
        // 直接绑定 mouseenter/mouseleave 到气泡图标上
        bubble.addEventListener('mouseenter', (e) => {
          bubble.style.opacity = '1';
          this.showTooltip(annotation.id, bubble, e);
        });
        bubble.addEventListener('mouseleave', () => {
          bubble.style.opacity = '0.55';
          this.scheduleHideTooltip();
        });
        
        mark.after(bubble);

        injected++;
      });
    });


  }

  private getActiveView(): MarkdownView | null {
    return this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
  }

  // ════════════════════════════════════════════
  //  右键菜单
  // ════════════════════════════════════════════

  /** 追加菜单项到原生编辑器菜单（Live Preview 模式下通过 editor-menu 事件调用） */
  appendMenuItems(menu: Menu, selection: string) {
    const view = this.getActiveView();
    if (!view) return;

    menu.addItem((item) => {
      item.setTitle('添加高亮');
      item.setIcon('highlighter');
      item.onClick(() => this.addHighlight(selection, view.editor, false));
    });

    menu.addItem((item) => {
      item.setTitle('添加划线');
      item.setIcon('underline');
      item.onClick(() => this.addUnderline(selection, view.editor, false));
    });

    menu.addItem((item) => {
      item.setTitle('添加批注');
      item.setIcon('message-square');
      item.onClick(() => this.showCommentModal(selection, view.editor, false));
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item.setTitle('AI 解释');
      item.setIcon('sparkles');
      item.onClick(() => this.askAIExplain(selection));
    });

    menu.addItem((item) => {
      item.setTitle('AI 翻译');
      item.setIcon('languages');
      item.onClick(() => this.askAITranslate(selection));
    });
  }

  /** Reading Mode 下的自定义右键菜单（拦截原生菜单） */
  private onContextMenu(e: MouseEvent) {
    // Live Preview 模式下不再拦截，由 editor-menu 事件处理
    if (!this.plugin.settings.readingContextMenu) return;

    const inReadingMode = isInReadingMode(e.target);
    if (!inReadingMode) return;

    // 使用保存的 selection（从 mouseup 事件获取），而不是在右键时才获取
    const selection = this.lastSelection || getReadingModeSelection() || '';
    if (!selection || selection.trim().length === 0) {

      return;
    }



    e.preventDefault();
    e.stopPropagation(); // 阻止事件继续传播

    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle('添加高亮');
      item.setIcon('highlighter');
      item.onClick(() => {

        this.addHighlight(selection, null, true);
      });
    });

    menu.addItem((item) => {
      item.setTitle('添加划线');
      item.setIcon('underline');
      item.onClick(() => this.addUnderline(selection, null, true));
    });

    menu.addItem((item) => {
      item.setTitle('添加批注');
      item.setIcon('message-square');
      item.onClick(() => this.showCommentModal(selection, null, true));
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item.setTitle('AI 解释');
      item.setIcon('sparkles');
      item.onClick(() => this.askAIExplain(selection, e.clientX, e.clientY));
    });

    menu.addItem((item) => {
      item.setTitle('AI 翻译');
      item.setIcon('languages');
      item.onClick(() => this.askAITranslate(selection, e.clientX, e.clientY));
    });

    menu.showAtMouseEvent(e);
  }

  /** 保存选中的文本（在鼠标释放时） */
  private onMouseUp(e: MouseEvent) {
    const inReadingMode = isInReadingMode(e.target);
    if (!inReadingMode) return;

    const selection = getReadingModeSelection();
    if (selection && selection.trim().length > 0) {
      this.lastSelection = selection;

    }
  }

  // ════════════════════════════════════════════
  //  气泡提示（Reading Mode 悬浮显示批注）
  // ════════════════════════════════════════════

  private async showTooltip(annotationId: string, bubble: HTMLElement, e: MouseEvent) {
    // 清除之前的隐藏定时器
    if (this.tooltipHideTimer) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }

    // 如果已存在相同的 tooltip，直接返回
    if (this.tooltipEl && this.tooltipEl.dataset['tooltipFor'] === annotationId) {
      return;
    }

    // 移除旧的 tooltip
    if (this.tooltipEl) {
      this.removeTooltip();
    }

    // 加载批注数据
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;

    const data = await this.plugin.store.load(file.path);
    const annotation = data.annotations.find(a => a.id === annotationId);
    if (!annotation || !annotation.comment) return;

    // 创建气泡
    this.tooltipEl = document.body.createDiv('fleur-annotation-tooltip');
    this.tooltipEl.dataset['tooltipFor'] = annotationId;
    this.tooltipEl.style.cssText = `
      position: fixed;
      z-index: 99999;
      background: var(--background-secondary);
      border: 1px solid var(--background-modifier-border);
      border-radius: 8px;
      padding: 10px 14px;
      max-width: 320px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-normal);
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      pointer-events: auto;
      opacity: 0;
      transition: opacity 0.15s ease;
      cursor: default;
      user-select: text;
    `;
    const cleanText = stripMarkdown(annotation.comment || '');
    this.tooltipEl.textContent = cleanText;

    // tooltip 自身的鼠标事件：进入时取消隐藏，离开时延迟隐藏
    this.tooltipEl.addEventListener('mouseenter', () => {
      if (this.tooltipHideTimer) {
        clearTimeout(this.tooltipHideTimer);
        this.tooltipHideTimer = null;
      }
    });
    this.tooltipEl.addEventListener('mouseleave', () => {
      this.scheduleHideTooltip();
    });

    // 定位到气泡图标下方
    const rect = bubble.getBoundingClientRect();
    this.tooltipEl.style.left = `${rect.left}px`;
    this.tooltipEl.style.top = `${rect.bottom + 6}px`;

    document.body.appendChild(this.tooltipEl);
    requestAnimationFrame(() => { this.tooltipEl!.style.opacity = '1'; });

    // 如果气泡超出屏幕底部，翻到上方
    const tooltipRect = this.tooltipEl.getBoundingClientRect();
    if (tooltipRect.bottom > window.innerHeight - 10) {
      this.tooltipEl.style.top = `${rect.top - tooltipRect.height - 6}px`;
    }
  }

  /** 立即隐藏 tooltip */
  private scheduleHideTooltip() {
    if (this.tooltipHideTimer) clearTimeout(this.tooltipHideTimer);
    this.removeTooltip();
  }

  private removeTooltip() {
    if (this.tooltipHideTimer) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }
    if (this.tooltipEl) {
      this.tooltipEl.style.opacity = '0';
      setTimeout(() => {
        this.tooltipEl?.remove();
        this.tooltipEl = null;
      }, 150);
    }
  }

  // ════════════════════════════════════════════
  //  点击处理
  // ════════════════════════════════════════════

  private onClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.classList.contains('fleur-annotation-delete')) {
      e.preventDefault();
      e.stopPropagation();
      const annotationId = target.dataset['annotationId'];
      if (annotationId) {
        this.deleteAnnotation(annotationId);
      }
    }
  }

  // ════════════════════════════════════════════
  //  侵入式编辑
  // ════════════════════════════════════════════

  private async addHighlight(selection: string, editor: Editor | null, inReadingMode: boolean) {

    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) {

      return;
    }

    if (inReadingMode) {
      const content = await this.plugin.app.vault.read(file);



      // 防重复包裹：文本若已被 == 包裹则跳过文件修改
      const alreadyWrapped = new RegExp(`==\\s*${escapeRegex(selection.trim())}\\s*==`).test(content);
      if (alreadyWrapped) {

        await this.plugin.store.addAnnotation(file.path, {
          id: this.plugin.generateId(),
          type: 'highlight',
          text: selection,
          color: '#FFC107',
          createdAt: Date.now(),
        });
        this.plugin.sidebar?.refreshAnnotations();
        new Notice('该文本已高亮');
        return;
      }

      // 跨段落选区：每段分别包裹 ==，因为 Obsidian ==高亮== 不能跨段落
      const wrapHighlight = (origMatched: string) => {
        if (origMatched.includes('\n\n')) {
          return origMatched.split(/\n\n+/).map(seg => `==${seg}==`).join('\n\n');
        } else if (origMatched.includes('\n')) {
          return origMatched.split(/\n+/).map(seg => `==${seg}==`).join('\n');
        }
        return `==${origMatched}==`;
      };
      const updated = findAndReplace(content, selection, wrapHighlight);

      
      if (updated) {

        await this.plugin.app.vault.modify(file, updated);

        // 刷新视图，保持在阅读模式
        const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
        const leaf = leaves.find(l => (l.view as any)?.file?.path === file.path);

        await leaf?.setViewState({
          type: 'markdown',
          state: { file: file.path, mode: 'preview' }
        });

      } else {

      }
    } else if (editor) {
      if (!wrapSelection(editor, '==', '==')) return;
    }

    await this.plugin.store.addAnnotation(file.path, {
      id: this.plugin.generateId(),
      type: 'highlight',
      text: selection,
      color: '#FFC107',
      createdAt: Date.now(),
    });

    this.plugin.sidebar?.refreshAnnotations();
    new Notice('已添加高亮');

    // 强制注入气泡
    setTimeout(() => this.forceInject(), 500);
  }

  private async addUnderline(selection: string, editor: Editor | null, inReadingMode: boolean) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;

    const underlineColor = this.plugin.settings.underlineColor || '#E8590C';
    const wrapPrefix = `<u style="color:${underlineColor}">`;
    const wrapSuffix = '</u>';

    if (inReadingMode) {
      const content = await this.plugin.app.vault.read(file);
      // <u> 也不能跨段落，每段分别包裹
      const wrapUnderline = (origMatched: string) => {
        if (origMatched.includes('\n\n')) {
          return origMatched.split(/\n\n+/).map(seg => `${wrapPrefix}${seg}${wrapSuffix}`).join('\n\n');
        } else if (origMatched.includes('\n')) {
          return origMatched.split(/\n+/).map(seg => `${wrapPrefix}${seg}${wrapSuffix}`).join('\n');
        }
        return `${wrapPrefix}${origMatched}${wrapSuffix}`;
      };
      const updated = findAndReplace(content, selection, wrapUnderline);
      if (updated) {
        await this.plugin.app.vault.modify(file, updated);
        // 刷新视图，保持在阅读模式
        const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
        const leaf = leaves.find(l => (l.view as any)?.file?.path === file.path);
        leaf?.setViewState({
          type: 'markdown',
          state: { file: file.path, mode: 'preview' }
        });
      }
    } else if (editor) {
      if (!wrapSelection(editor, wrapPrefix, wrapSuffix)) return;
    }

    await this.plugin.store.addAnnotation(file.path, {
      id: this.plugin.generateId(),
      type: 'underline',
      text: selection,
      color: underlineColor,
      createdAt: Date.now(),
    });

    this.plugin.sidebar?.refreshAnnotations();
    new Notice('已添加划线');
  }

  /** 显示批注输入弹窗 */
  private showCommentModal(selection: string, editor: Editor | null, inReadingMode: boolean) {
    const modal = new CommentModal(this.plugin, selection, async (comment) => {
      await this.saveComment(selection, comment, editor, inReadingMode);
    });
    modal.open();
  }

  private async saveComment(selection: string, comment: string, editor: Editor | null, inReadingMode: boolean) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;

    if (inReadingMode) {
      const content = await this.plugin.app.vault.read(file);
      // 批注 = 高亮 + 内联注释：==文本==%% 批注 %%
      // == 不能跨段落，每段分别包裹
      const wrapComment = (origMatched: string) => {
        const segments = origMatched.includes('\n\n')
          ? origMatched.split(/\n\n+/)
          : origMatched.includes('\n')
            ? origMatched.split(/\n+/)
            : [origMatched];
        const sep = origMatched.includes('\n\n') ? '\n\n' : origMatched.includes('\n') ? '\n' : '';
        return segments.map(seg => `==${seg}==%% ${comment} %%`).join(sep);
      };
      const updated = findAndReplace(content, selection, wrapComment);
      if (updated) {
        await this.plugin.app.vault.modify(file, updated);
        // 刷新视图，保持在阅读模式
        const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
        const leaf = leaves.find(l => (l.view as any)?.file?.path === file.path);
        leaf?.setViewState({
          type: 'markdown',
          state: { file: file.path, mode: 'preview' }
        });
      }
    } else if (editor) {
      // Live Preview: ==选中文本==%% 批注 %%
      if (!wrapSelection(editor, '==', `==%% ${comment} %%`)) return;
    }

    await this.plugin.store.addAnnotation(file.path, {
      id: this.plugin.generateId(),
      type: 'comment',
      text: selection,
      color: '#FFC107',
      comment: comment,
      createdAt: Date.now(),
    });

    this.plugin.sidebar?.refreshAnnotations();
    new Notice('已添加批注');

    // 延迟注入气泡（等待 DOM 更新）
    setTimeout(() => this.forceInject(), 500);
  }

  // ═══════════════════════════════════════════
  //  AI 功能
  // ═══════════════════════════════════════════

  private askAIExplain(text: string, anchorX?: number, anchorY?: number) {
    const panel = new AIChatPanel(this.plugin, text, 'explain');
    panel.open(anchorX, anchorY);
  }

  private askAITranslate(text: string, anchorX?: number, anchorY?: number) {
    const panel = new AIChatPanel(this.plugin, text, 'translate');
    panel.open(anchorX, anchorY);
  }

  // ════════════════════════════════════════════
  //  删除批注
  // ════════════════════════════════════════════

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 将文本拆分为词组，用 \s+ 连接，实现模糊空白匹配 */
  private makeFuzzyPattern(text: string): string {
    const parts = text.trim().split(/\s+/).map(p => this.escapeRegex(p));
    return parts.join('\\s+');
  }

  async deleteAnnotation(annotationId: string) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;

    const data = await this.plugin.store.load(file.path);
    const annotation = data.annotations.find(a => a.id === annotationId);
    if (!annotation) return;

    const view = this.getActiveView();
    const editor = view?.editor;

    if (editor) {
      const content = editor.getValue();
      const updated = this.tryUnwrap(content, annotation);
      if (updated !== content) {
        editor.setValue(updated);
      }
    } else {
      const content = await this.plugin.app.vault.read(file);
      const updated = this.tryUnwrap(content, annotation);
      if (updated !== content) {
        await this.plugin.app.vault.modify(file, updated);
        const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
        const leaf = leaves.find(l => (l.view as any)?.file?.path === file.path);
        leaf?.setViewState({
          type: 'markdown',
          state: { file: file.path, mode: 'preview' }
        });
      }
    }

    await this.plugin.store.deleteAnnotation(file.path, annotationId);
    this.plugin.sidebar?.refreshAnnotations();
    new Notice('已删除批注');
  }

  /** 尝试移除标注包裹，带多级回退 */
  private tryUnwrap(content: string, annotation: { type: string; text: string; color?: string; comment?: string }): string {
    const result = this.buildUnwrapRegex(content, annotation, annotation.text);
    if (result !== null && result !== content) return result;

    // 回退 1：精确字符串移除
    const patterns = this.getDeletePatterns(annotation);
    for (const p of patterns) {
      if (content.includes(p)) {
        return content.replace(p, p.startsWith('==') && p.endsWith('%%') ? annotation.text : '');
      }
    }

    // 回退 2：只移除 %% 批注 %%
    if (annotation.comment) {
      const commentMarkers = [`%% ${annotation.comment} %%`, `%%${annotation.comment}%%`];
      for (const m of commentMarkers) {
        if (content.includes(m)) return content.replace(m, '');
      }
    }

    // 回退 3：移除标注文本本身（最后的兜底）
    if (content.includes(annotation.text)) {
      return content.replace(annotation.text, '');
    }

    // 回退 4：源文件含 **bold** 等 Markdown 标记，annotation.text 是纯文本
    // 扫描所有 ==...== 段，剥离内联 Markdown 后与 annotation.text 比较
    if (annotation.type === 'highlight') {
      const stripped = this.stripInlineMarkdown(annotation.text);
      const regex = /==([^=]+)==/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const inner = match[1];
        if (this.stripInlineMarkdown(inner) === stripped) {
          // 匹配成功：移除 == 标记，保留内部原始内容（含 ** 等）
          return content.substring(0, match.index) + inner + content.substring(match.index + match[0].length);
        }
      }
    }

    return content;
  }

  /** 剥离内联 Markdown 标记（**、~~、`），用于删除时的模糊文本比较 */
  private stripInlineMarkdown(text: string): string {
    return text.replace(/\*\*([^*]+?)\*\*/g, '$1')
               .replace(/~~([^~]+?)~~/g, '$1')
               .replace(/`([^`]+?)`/g, '$1');
  }

  /** 生成删除时尝试匹配的精确字符串模式 */
  private getDeletePatterns(annotation: { type: string; text: string; color?: string; comment?: string }): string[] {
    const patterns: string[] = [];
    if (annotation.type === 'comment' && annotation.comment) {
      patterns.push(`==${annotation.text}==%% ${annotation.comment} %%`);
      patterns.push(`${annotation.text}%% ${annotation.comment} %%`);
      patterns.push(`==${annotation.text}==%%${annotation.comment}%%`);
      patterns.push(`${annotation.text}%%${annotation.comment}%%`);
    }
    if (annotation.type === 'highlight') {
      patterns.push(`==${annotation.text}==`);
    }
    if (annotation.type === 'underline') {
      patterns.push(`<u style="color:${annotation.color || '#E8590C'}">${annotation.text}</u>`);
      patterns.push(`<u>${annotation.text}</u>`);
    }
    return patterns;
  }

  /**
   * 用模糊匹配移除包裹标记，匹配失败时用精确匹配回退
   */
  private unwrapFuzzy(content: string, wrappedPrefix: string, wrappedSuffix: string, annotationText: string): string {
    // 先尝试模糊匹配（处理空白差异）
    const parts = annotationText.trim().split(/\s+/).map(p => this.escapeRegex(p));
    const fuzzyText = parts.join('[\\s\\u00a0]*');  // 用 [\s\u00a0]* 匹配任意空白（包括不可见空格）
    const regex = new RegExp(`${this.escapeRegex(wrappedPrefix)}(${fuzzyText})${this.escapeRegex(wrappedSuffix)}`, 'g');

    const result = content.replace(regex, (_match, captured: string) => captured);
    if (result !== content) return result;

    // 回退：精确匹配（处理特殊情况）
    const exactWrapped = `${wrappedPrefix}${annotationText}${wrappedSuffix}`;
    return content.replace(exactWrapped, annotationText);
  }

  /** 用模糊空白匹配构建正则，移除高亮/划线/批注包裹 */
  private buildUnwrapRegex(content: string, annotation: { type: string; text: string; color?: string; comment?: string }, _plainText: string): string | null {
    if (annotation.type === 'highlight') {
      return this.unwrapFuzzy(content, '==', '==', annotation.text);
    }

    if (annotation.type === 'underline') {
      const parts = annotation.text.trim().split(/\s+/).map(p => this.escapeRegex(p));
      const fuzzyText = parts.join('[\\s\\u00a0]*');
      // 兼容裸 <u> 和带 style 的 <u style="color:...">
      const regex = new RegExp(`<u(?:\\s+style="[^"]*")?>[\\s\\u00a0]*(${fuzzyText})[\\s\\u00a0]*</u>`, 'g');
      const r1 = content.replace(regex, (_m, c: string) => c);
      if (r1 !== content) return r1;
      // 回退：精确匹配（裸 <u>）
      const exactWrapped1 = `<u>${annotation.text}</u>`;
      const r2 = content.replace(exactWrapped1, annotation.text);
      if (r2 !== content) return r2;
      // 回退：精确匹配（带 style）
      const exactWrapped2 = `<u style="color:${annotation.color || '#E8590C'}">${annotation.text}</u>`;
      return content.replace(exactWrapped2, annotation.text);
    }

    if (annotation.type === 'comment') {
      const fuzzyComment = annotation.comment ? annotation.comment.trim().split(/\s+/).map(p => this.escapeRegex(p)).join('[\\s\\u00a0]*') : '';

      if (fuzzyComment) {
        const fuzzyText = this.makeFuzzyPattern(annotation.text).replace(/\\s\+/g, '[\\s\\u00a0]*');
        // 带高亮的批注：==文本==%% 批注 %%
        const regex1 = new RegExp(`==(${fuzzyText})==%%[\\s\\u00a0]*${fuzzyComment}[\\s\\u00a0]*%%`, 'g');
        const r1 = content.replace(regex1, (_m, c: string) => c);
        if (r1 !== content) return r1;
        // 不带高亮的批注：文本%% 批注 %%
        const regex2 = new RegExp(`(${fuzzyText})%%[\\s\\u00a0]*${fuzzyComment}[\\s\\u00a0]*%%`, 'g');
        const r2 = content.replace(regex2, (_m, c: string) => c);
        if (r2 !== content) return r2;
        // 回退：精确匹配
        const exact1 = `==${annotation.text}==%% ${annotation.comment} %%`;
        const r3 = content.replace(exact1, annotation.text);
        if (r3 !== content) return r3;
        const exact2 = `${annotation.text}%% ${annotation.comment} %%`;
        return content.replace(exact2, annotation.text);
      }
      // 无批注内容，只移除 %% 包裹
      return this.unwrapFuzzy(content, '==%%', '%%', annotation.text);
    }

    return content;
  }
}
