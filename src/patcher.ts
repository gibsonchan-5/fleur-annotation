// Markdown 编辑器拦截 + 右键菜单 + 侵入式编辑
// 支持 Live Preview 模式和 Reading Mode
import { Menu, MarkdownView, Notice, Modal, TFile, Platform, setIcon } from 'obsidian';
import type { Editor, MarkdownPreviewView } from 'obsidian';
import type FleurAnnotationPlugin from './main';
import type { Annotation } from './types';
import { AIChatPanel } from './ai-chat-modal';
import { wrapSelection, appendToSelection, findAndReplace, findNthIndex, wrapSegmented, getBodyStartOffset, getReadingModeSelection, getReadingModeOccurrence, isInReadingMode, isInLivePreview, stripMarkdown, escapeRegex } from './editor';

// ═══════════════════════════════════════════
//  定位辅助：文本归一化 / 多级匹配 / 滚动容器
// ═══════════════════════════════════════════

/** 归一化用于匹配的文本：去空白与零宽字符、统一引号与全角标点、小写 */
function normalizeForMatch(s: string): string {
  return (s || '')
    .replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF\u2028\u2029\u0085]+/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u3003]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/\uFF08/g, '(')
    .replace(/\uFF09/g, ')')
    .replace(/\uFF1A/g, ':')
    .replace(/\uFF1B/g, ';')
    .replace(/\uFF0C/g, ',')
    .replace(/[\uFF0E\u3002]/g, '.')
    .replace(/\uFF01/g, '!')
    .replace(/\uFF1F/g, '?')
    .replace(/\u3010/g, '[')
    .replace(/\u3011/g, ']')
    .replace(/[\u2014\u2015]/g, '-')
    .toLowerCase();
}

/**
 * 多级匹配：返回 4=精确 / 3=包含 / 2=前缀 / 1=相似 / 0=不匹配。
 * 用于判断 DOM 渲染文本与批注记录文本是否指向同一处（容忍引号变形、截断、气泡文本混入）。
 */
function matchLevel(rendered: string, target: string): number {
  if (!rendered || !target) return 0;
  // 过短的渲染文本（如单个标点）不足以判定，只认完全相等，避免误命中
  if (rendered.length < 6) return rendered === target ? 4 : 0;

  if (rendered === target) return 4;
  if (rendered.includes(target) || target.includes(rendered)) return 3;

  // 前缀匹配：首 16 字符互含（应对尾部被截断或追加的情况）
  const K = 16;
  const rp = rendered.slice(0, K);
  const tp = target.slice(0, K);
  if (rp.length >= 8 && target.includes(rp)) return 2;
  if (tp.length >= 8 && rendered.includes(tp)) return 2;

  // 相似度：以 10 字符滑窗统计覆盖率
  const win = 10;
  if (target.length >= win) {
    let hitCount = 0;
    let total = 0;
    for (let i = 0; i + win <= target.length; i += win) {
      total++;
      if (rendered.includes(target.slice(i, i + win))) hitCount++;
    }
    if (total > 0 && hitCount / total >= 0.6) return 1;
  }
  return 0;
}

/** 元素是否真正占位可见（隐藏视图里的元素高宽为 0，命中它不会有任何视觉反馈） */
function isVisible(el: HTMLElement): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

/** 向上查找最近的可滚动祖先（阅读模式的滚动容器是 .markdown-preview-view） */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const overflowY = getComputedStyle(cur).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** 自定义批注输入弹窗：支持拖拽（标题栏）、右下角缩放、高度自适应内容 */
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

    // 标题（同时作为拖拽手柄）
    const titleEl = contentEl.createEl('h3', { text: '添加批注' });
    titleEl.addClass('fleur-modal-title');
    this.makeDraggable(titleEl);

    // 选中文本预览
    const label = contentEl.createDiv({ text: '选中文本' });
    label.addClass('fleur-modal-label');

    const preview = contentEl.createDiv();
    preview.addClass('fleur-modal-preview');
    preview.textContent = this.previewText;

    // 批注输入
    const inputLabel = contentEl.createDiv({ text: '批注内容' });
    inputLabel.addClass('fleur-modal-label');

    this.textarea = contentEl.createEl('textarea');
    this.textarea.placeholder = '写下你的想法…';
    this.textarea.addClass('fleur-modal-textarea');

    // 按钮行
    const btnRow = contentEl.createDiv();
    btnRow.addClass('fleur-modal-btn-row');

    const cancelBtn = btnRow.createEl('button', { text: '取消' });
    cancelBtn.addClass('fleur-modal-btn-cancel');
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = btnRow.createEl('button', { text: '确定' });
    confirmBtn.addClass('fleur-modal-btn-confirm');
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

    // 右下角缩放手柄
    this.addResizeHandle();

    setTimeout(() => this.textarea.focus(), 50);
  }

  /** 标题栏拖拽：首次拖动时脱离 flex 居中改为绝对定位 */
  private makeDraggable(handle: HTMLElement) {
    handle.addClass('fleur-modal-drag-handle');

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();

      const rect = this.modalEl.getBoundingClientRect();
      // 切换为绝对定位，固定当前位置
      this.modalEl.setCssStyles({
        position: 'absolute',
        margin: '0',
        left: `${rect.left}px`,
        top: `${rect.top}px`
      });

      const startX = e.clientX;
      const startY = e.clientY;
      const originLeft = rect.left;
      const originTop = rect.top;
      document.body.addClass('fleur-modal-dragging');

      const onMove = (ev: MouseEvent) => {
        const w = this.modalEl.offsetWidth;
        const h = this.modalEl.offsetHeight;
        const x = Math.min(Math.max(originLeft + (ev.clientX - startX), -w + 80), window.innerWidth - 80);
        const y = Math.min(Math.max(originTop + (ev.clientY - startY), 0), window.innerHeight - 40);
        this.modalEl.setCssStyles({ left: `${x}px`, top: `${y}px` });
      };
      const onUp = () => {
        document.body.removeClass('fleur-modal-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /** 右下角缩放手柄（仅调宽度，高度固定） */
  private addResizeHandle() {
    const handle = this.modalEl.createDiv();
    handle.addClass('fleur-modal-resize-handle');

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = this.modalEl.getBoundingClientRect();
      const startX = e.clientX;
      const startW = rect.width;

      const onMove = (ev: MouseEvent) => {
        const w = Math.min(Math.max(380, startW + (ev.clientX - startX)), window.innerWidth - 40);
        this.modalEl.setCssStyles({ width: `${w}px` });
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
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

  /** 移动端选区工具条：selectionchange 监听与稳定判定定时器 */
  private boundSelectionChange: (() => void) | null = null;
  private mSelTimer: ReturnType<typeof setTimeout> | null = null;
  /** 选区文本快照：工具条点击时选区可能已塌缩，用快照兜底（对齐 fleurEpub selSnapshot） */
  private mSelSnapshot = '';
  private mSelBar: HTMLElement | null = null;

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

    // 移动端：选区工具条（触屏没有右键语义，长按选中后底部弹出，对齐 fleurEpub mselbar；
    // 桌面端不注册，交互完全不受影响）
    if (Platform.isMobile) {
      this.boundSelectionChange = () => {
        if (this.mSelTimer) clearTimeout(this.mSelTimer);
        // 触摸选段没有 mouseup 语义，靠「选区 300ms 不再变化」判定稳定（对齐 fleurEpub）
        this.mSelTimer = setTimeout(() => this.onMobileSelectionStable(), 300);
      };
      document.addEventListener('selectionchange', this.boundSelectionChange);
    }
  }

  uninstall() {
    if (this.boundContextMenu) document.removeEventListener('contextmenu', this.boundContextMenu, true);
    if (this.boundClick) document.removeEventListener('click', this.boundClick, true);
    if (this.boundMouseUp) document.removeEventListener('mouseup', this.boundMouseUp, true);
    if (this.boundSelectionChange) document.removeEventListener('selectionchange', this.boundSelectionChange);
    if (this.mSelTimer) clearTimeout(this.mSelTimer);
    this.hideMobileSelectionBar();
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    if (this.injectTimer) clearTimeout(this.injectTimer);
    this.removeTooltip();
    this.hideMobileAnnotationCard();
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
   * 查找所有 <mark> 元素，匹配批注数据后注入 data-fleur-annotation 属性 + 小气泡图标。
   * id 注入面向全部批注（高亮/划线/批注）——移动端点按清除靠它做 O(1) 命中；
   * 气泡图标仍只给带批注内容的（桌面 hover 展示批注，纯高亮没有可展示的内容）。
   */
  private async injectCommentBubbles() {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;

    const data = await this.plugin.store.load(file.path);
    const annotations = data.annotations.filter(a => !a.deletedAt);
    // 带批注内容的才注入气泡图标
    const commentAnnotations = annotations.filter(a => a.comment);

    if (annotations.length === 0) return;

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
          const isFleurUnderline = annotations.some(a => {
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


        const annotation = annotations.find(a => {
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
        markEl.addClass('fleur-annotation-mark');

        // 气泡图标只给带批注内容的（纯高亮/划线无可展示内容；
        // 移动端点按清除对所有类型生效，靠上面的 data-fleur-annotation id）
        if (!annotation.comment) return;

        // 创建小气泡图标
        const bubble = markEl.createEl('span');
        bubble.addClass('fleur-annotation-bubble');
        bubble.dataset.fleurAnnotation = annotation.id;

        // 使用 DOM API 创建 SVG（避免 innerHTML）
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
        svg.appendChild(path);
        bubble.appendChild(svg);

        // 直接绑定 mouseenter/mouseleave 到气泡图标上
        bubble.addEventListener('mouseenter', (e) => {
          this.showTooltip(annotation.id, bubble, e);
        });
        bubble.addEventListener('mouseleave', () => {
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

  // ── 移动端选区工具条（对齐 fleurEpub mselbar 设计）──────────────

  /** selectionchange 稳定后回调：选区仍存在且在笔记正文内 → 底部弹出工具条 */
  private onMobileSelectionStable() {
    const sel = document.getSelection();
    const text = sel?.toString() ?? '';
    if (!text.trim()) {
      this.hideMobileSelectionBar();
      return;
    }
    const anchorEl = sel!.anchorNode instanceof Element
      ? sel!.anchorNode as Element
      : sel!.anchorNode?.parentElement;
    if (!anchorEl) {
      this.hideMobileSelectionBar();
      return;
    }
    // 只对笔记正文生效（编辑/阅读两种模式），插件自身 UI 与弹窗内选区不触发
    if (!anchorEl.closest('.markdown-source-view, .markdown-reading-view, .markdown-preview-view')) {
      this.hideMobileSelectionBar();
      return;
    }
    if (anchorEl.closest('.fleur-ai-panel, .fleur-sidebar, .modal, .menu')) {
      this.hideMobileSelectionBar();
      return;
    }
    this.mSelSnapshot = text;
    // 防闪烁：工具条已在显示（selectionchange 连发）→ 仅刷新快照，不拆建
    if (this.mSelBar) return;
    this.showMobileSelectionBar();
  }

  /** 底部工具条：只放系统菜单没有的能力（高亮/划线/批注/AI），不放复制——对齐 fleurEpub 决策① */
  private showMobileSelectionBar() {
    this.hideMobileSelectionBar();
    const bar = document.body.createDiv('fleur-mselbar');
    // 落位前先隐形，等量宽完成再显形，避免闪位
    bar.setCssStyles({ visibility: 'hidden' });
    this.mSelBar = bar;
    // 阻止 mousedown 让选区塌缩（触屏上 touchstart 亦同）
    const press = (el: HTMLElement) => el.addEventListener('mousedown', (e) => e.preventDefault());

    const mkBtn = (label: string, title: string, fn: () => void) => {
      const b = bar.createSpan('fleur-mselbar-btn');
      b.setText(label);
      b.setAttribute('aria-label', title);
      press(b);
      b.addEventListener('click', () => {
        this.hideMobileSelectionBar();
        fn();
      });
    };

    // 高亮色点（取当前设置色）
    const dot = bar.createSpan('fleur-mselbar-dot');
    dot.setCssStyles({ background: this.plugin.settings.highlightColor });
    dot.setAttribute('aria-label', '添加高亮');
    press(dot);
    dot.addEventListener('click', () => {
      this.hideMobileSelectionBar();
      void this.useMobileSelection((sel, view, inReading) =>
        this.addHighlight(sel, inReading ? null : view, inReading));
    });
    bar.createDiv('fleur-mselbar-sep');

    mkBtn('U', '添加划线', () => {
      void this.useMobileSelection((sel, view, inReading) =>
        this.addUnderline(sel, inReading ? null : view, inReading));
    });
    mkBtn('✎', '添加批注', () => {
      this.useMobileSelection((sel, view, inReading) =>
        this.showCommentModal(sel, inReading ? null : view, inReading));
    });
    bar.createDiv('fleur-mselbar-sep');
    mkBtn('AI', 'AI 解释', () => {
      this.useMobileSelection((sel) => this.askAIExplain(sel));
    });
    mkBtn('译', 'AI 翻译', () => {
      this.useMobileSelection((sel) => this.askAITranslate(sel));
    });

    // 两次 rAF：首帧字号未落定时量到的宽度偏大，落位会算歪（对齐 fleurEpub）
    const place = () => {
      if (this.mSelBar !== bar) return;
      const bw = bar.offsetWidth;
      const left = Math.max(8, (window.innerWidth - bw) / 2);
      bar.setCssStyles({
        left: `${left}px`,
        right: 'auto',
        visibility: '',
      });
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(place));
  }

  private hideMobileSelectionBar() {
    if (this.mSelBar) {
      this.mSelBar.remove();
      this.mSelBar = null;
    }
  }

  /** 工具条按钮公共入口：取当前活动视图与模式，把快照文本分发给批注 API；无活动笔记则忽略 */
  private useMobileSelection(fn: (sel: string, editor: Editor | null, inReadingMode: boolean) => void): void {
    const view = this.getActiveView();
    const sel = this.mSelSnapshot;
    if (!sel.trim()) return;
    if (!view) {
      new Notice('没有活动的笔记');
      return;
    }
    const inReading = view.getMode() === 'preview';
    fn(sel, inReading ? null : view.editor, inReading);
  }

  /** Reading Mode 下的自定义右键菜单（拦截原生菜单） */
  private onContextMenu(e: MouseEvent) {
    // 移动端不弹自定义菜单：触屏长按会同时触发系统选区菜单（不走 DOM contextmenu，
    // preventDefault 拦不住），自定义菜单再叠上去就是两层悬浮菜单且盖住选区手柄。
    // 移动端唯一入口 = 底部工具条 mselbar（对齐 fleurEpub 决策）
    if (Platform.isMobile) return;
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

    // 右键时选区仍在 DOM 上，立即推断是同文本的第几处出现（供高亮/划线/批注定位到正确的那一处）
    const occurrence = getReadingModeOccurrence(selection);

    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle('复制');
      item.setIcon('copy');
      item.onClick(() => this.copyText(selection));
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item.setTitle('添加高亮');
      item.setIcon('highlighter');
      item.onClick(() => {

        this.addHighlight(selection, null, true, occurrence);
      });
    });

    menu.addItem((item) => {
      item.setTitle('添加划线');
      item.setIcon('underline');
      item.onClick(() => this.addUnderline(selection, null, true, occurrence));
    });

    menu.addItem((item) => {
      item.setTitle('添加批注');
      item.setIcon('message-square');
      item.onClick(() => this.showCommentModal(selection, null, true, occurrence));
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

    } else {
      // 选区已取消：清空缓存，避免右键时误操作上一次的旧选区
      this.lastSelection = null;
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
    this.tooltipEl.addClass('fleur-annotation-tooltip');
    const cleanText = stripMarkdown(annotation.comment || '');

    // 文本容器：JS 控制截断，不依赖 CSS line-clamp
    const textContainer = this.tooltipEl.createDiv('fleur-tooltip-text');
    const MAX_CHARS = 120;
    const isLong = cleanText.length > MAX_CHARS;
    textContainer.textContent = isLong ? cleanText.slice(0, MAX_CHARS) + '...' : cleanText;

    // 展开/收起提示
    let tooltipExpanded = false;
    const tooltipHint = this.tooltipEl.createDiv('fleur-tooltip-toggle-hint');
    tooltipHint.textContent = '展开全文 ›';
    tooltipHint.setCssStyles({ display: isLong ? 'block' : 'none' });
    tooltipHint.addEventListener('click', (e) => {
      e.stopPropagation();
      tooltipExpanded = !tooltipExpanded;
      if (tooltipExpanded) {
        textContainer.textContent = cleanText;
        tooltipHint.textContent = '收起 ▲';
      } else {
        textContainer.textContent = cleanText.slice(0, MAX_CHARS) + '...';
        tooltipHint.textContent = '展开全文 ›';
      }
    });

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
    this.tooltipEl.setCssStyles({
      left: `${rect.left}px`,
      top: `${rect.bottom + 6}px`
    });

    document.body.appendChild(this.tooltipEl);
    requestAnimationFrame(() => { this.tooltipEl!.addClass('is-visible'); });

    // 如果气泡超出屏幕底部，翻到上方
    const tooltipRect = this.tooltipEl.getBoundingClientRect();
    if (tooltipRect.bottom > window.innerHeight - 10) {
      this.tooltipEl.setCssStyles({ top: `${rect.top - tooltipRect.height - 6}px` });
    }
  }

  /** 延迟隐藏 tooltip（给用户时间移到 tooltip 上点击"展开全文"） */
  private scheduleHideTooltip() {
    if (this.tooltipHideTimer) clearTimeout(this.tooltipHideTimer);
    this.tooltipHideTimer = setTimeout(() => this.removeTooltip(), 600);
  }

  private removeTooltip() {
    if (this.tooltipHideTimer) {
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }
    if (this.tooltipEl) {
      this.tooltipEl.removeClass('is-visible');
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
    // ── 移动端动作卡交互：全部走 document 捕获路径 ──
    // 真机上 target 级 click 监听在触屏合成事件下不可达（实测卡片能弹出但按钮不响应，
    // 而打开卡片走的就是这条捕获路径）；统一在此处理，按钮元素上不再挂监听。
    const mBtn = target.closest?.('.fleur-ann-mcard-btn') as HTMLElement | null;
    if (mBtn) {
      e.preventDefault();
      e.stopPropagation();
      const annId = mBtn.dataset['annId'];
      this.hideMobileAnnotationCard();
      if (annId) {
        this.deleteAnnotation(annId).catch(err =>
          new Notice(`清除失败：${err instanceof Error ? err.message : String(err)}`));
      }
      return;
    }
    const mToggle = target.closest?.('.fleur-ann-mcard-toggle') as HTMLElement | null;
    if (mToggle) {
      e.stopPropagation();
      const card = mToggle.closest('.fleur-ann-mcard') as HTMLElement | null;
      const comment = card?.dataset['comment'] ?? '';
      const textEl = card?.querySelector('.fleur-ann-mcard-text');
      if (card && textEl) {
        const expanded = card.dataset['expanded'] === '1';
        const MAX_CHARS = 120;
        textEl.textContent = expanded ? comment.slice(0, MAX_CHARS) + '...' : comment;
        card.dataset['expanded'] = expanded ? '' : '1';
        mToggle.setText(expanded ? '展开全文 ›' : '收起 ▲');
      }
      return;
    }
    if (target.classList.contains('fleur-annotation-delete')) {
      e.preventDefault();
      e.stopPropagation();
      const annotationId = target.dataset['annotationId'];
      if (annotationId) {
        this.deleteAnnotation(annotationId);
      }
      return;
    }
    // 移动端：轻点已划文本 → 标注动作卡（查看批注内容 / 清除），对齐 fleurEpub showAnnotationActionSheet；
    // 桌面不进入此分支，hover tooltip / 右键菜单行为不变
    if (Platform.isMobile) this.onMobileTap(e, target);
  }

  // ════════════════════════════════════════════
  //  移动端点按标注 → 动作卡（对齐 fleurEpub annquick：
  //  纯高亮/划线 → 紧凑清除卡；带批注内容 → 内容 + 清除按钮。
  //  给出明确选项，不直接擦除——对齐产品线「不直接擦除」决策）
  // ════════════════════════════════════════════

  private mAnnCard: HTMLElement | null = null;
  private mAnnCardClose: (() => void) | null = null;

  /** 移动端点击路由：命中 fleur 标注元素 → 弹动作卡 */
  private onMobileTap(e: MouseEvent, target: HTMLElement) {
    // 插件自身 UI / 弹窗 / 菜单内的点击不放行
    if (target.closest('.fleur-mselbar, .fleur-ann-mcard, .fleur-ai-mobile, .fleur-annotation-tooltip, .modal-container, .menu, .suggestion-container')) return;
    // 正在选段（长按拖手柄）时不干预
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    // 命中标注元素：mark / .cm-highlight / u（正文自带 u 无 id 且文本匹配不上，自然放行）
    const hit = target.closest('mark, .cm-highlight, u, .fleur-annotation-bubble') as HTMLElement | null;
    if (!hit) return;
    // 不在笔记正文内（如弹窗里的展示区）不干预
    if (!hit.closest('.markdown-source-view, .markdown-reading-view, .markdown-preview-view')) return;

    const annotationId = hit.dataset.fleurAnnotation
      || (hit.classList.contains('fleur-annotation-bubble') ? hit.dataset.fleurAnnotation : '');
    const x = e.clientX;
    const y = e.clientY;
    if (annotationId) {
      e.preventDefault();
      e.stopPropagation();
      void this.showMobileAnnotationCard(annotationId, x, y);
      return;
    }
    // 兜底：注入 debounce 未跑完时 DOM 上还没有 id → 按文本匹配（异步，坐标已捕获）
    void this.resolveTapByText(hit, x, y);
  }

  /** 文本匹配兜底：normalize 双向包含 + occurrence 消歧（与 injectCommentBubbles 同策略） */
  private async resolveTapByText(hit: HTMLElement, x: number, y: number) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;
    const data = await this.plugin.store.load(file.path);
    const live = data.annotations.filter(a => !a.deletedAt && a.text);
    if (live.length === 0) return;
    const norm = (s: string) => s.replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF]+/g, '').toLowerCase();
    const rendered = norm(hit.textContent || '');
    if (!rendered) return;
    const candidates = live.filter(a => {
      const t = norm(a.text!);
      return rendered === t || rendered.includes(t) || t.includes(rendered);
    });
    if (candidates.length === 0) return;
    // occurrence 消歧：命中元素是容器内同文本标注元素中的第几处
    const container = hit.closest('.cm-content, .markdown-preview-view') ?? document.body;
    let occ = 0;
    for (const el of Array.from(container.querySelectorAll('mark, .cm-highlight, u'))) {
      if (el === hit) break;
      if (norm((el as HTMLElement).textContent || '') === rendered) occ++;
    }
    const ann = candidates[Math.min(occ, candidates.length - 1)];
    if (ann) void this.showMobileAnnotationCard(ann.id, x, y);
  }

  /** 弹出移动端标注动作卡（点外部 / Esc 关闭） */
  private async showMobileAnnotationCard(annotationId: string, x: number, y: number) {
    this.hideMobileAnnotationCard();
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;
    const data = await this.plugin.store.load(file.path);
    const ann = data.annotations.find(a => a.id === annotationId && !a.deletedAt);
    if (!ann) return;

    this.hideMobileSelectionBar();
    // 双保险：await load 的间隙里若又触发了一次打开，会残留旧卡——统一清掉
    document.querySelectorAll('.fleur-ann-mcard').forEach(el => el.remove());
    const card = document.body.createDiv('fleur-ann-mcard');
    this.mAnnCard = card;

    // 带批注内容 → 展示内容（120 字截断 + 展开切换，与桌面 tooltip 同策略）
    const comment = ann.comment ? stripMarkdown(ann.comment) : '';
    if (comment) {
      card.dataset['comment'] = comment;
      const MAX_CHARS = 120;
      const isLong = comment.length > MAX_CHARS;
      const textEl = card.createDiv('fleur-ann-mcard-text');
      textEl.setText(isLong ? comment.slice(0, MAX_CHARS) + '...' : comment);
      if (isLong) {
        // 展开/收起交互在 onClick 捕获路径处理（真机 target 级监听不可靠）
        card.createDiv('fleur-ann-mcard-toggle').setText('展开全文 ›');
      }
    }

    // 清除按钮：按类型描述动作（微信读书式明确选项，不直接擦除）。
    // 按钮上不挂监听——点击统一由 onClick 捕获路径按 data-ann-id 分发
    const label = ann.type === 'highlight' ? '清除高亮' : ann.type === 'underline' ? '清除下划线' : '清除批注';
    const btn = card.createDiv('fleur-ann-mcard-btn');
    btn.dataset['annId'] = ann.id;
    btn.setAttribute('aria-label', label);
    setIcon(btn.createSpan('fleur-ann-mcard-icon'), 'eraser');
    btn.createSpan('fleur-ann-mcard-label').setText(label);

    // 定位到点按处附近（翻转防出屏），点外部 / Esc 关闭
    this.placeMobileCard(card, x, y);
    // 点外部关闭：pointerdown 捕获（fleurEpub mountAnnPopupClose 同款鼠标语义）。
    // pointerdown 先于 click 合成，与按钮的 click 处理零耦合，互不干扰
    const outside = (ev: Event) => {
      if (!card.contains(ev.target as Node)) this.hideMobileAnnotationCard();
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.hideMobileAnnotationCard();
    };
    this.mAnnCardClose = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', esc, true);
    };
    // 延迟挂载：打开卡片的那次手势尚未结束，立即挂会当场把自己关掉
    window.setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
  }

  /** 动作卡定位：默认出现在点按处下方，越界翻转、四边钳制 */
  private placeMobileCard(card: HTMLElement, x: number, y: number) {
    card.setCssStyles({ visibility: 'hidden', left: `${x}px`, top: `${y}px` });
    window.requestAnimationFrame(() => {
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const margin = 8;
      let left = x - w / 2;
      let top = y + 14;
      if (left < margin) left = margin;
      if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w;
      if (top + h > window.innerHeight - margin) top = y - h - 14;
      if (top < margin) top = margin;
      card.setCssStyles({ left: `${left}px`, top: `${top}px`, visibility: '' });
    });
  }

  private hideMobileAnnotationCard() {
    if (this.mAnnCardClose) {
      this.mAnnCardClose();
      this.mAnnCardClose = null;
    }
    if (this.mAnnCard) {
      this.mAnnCard.remove();
      this.mAnnCard = null;
    }
  }

  // ════════════════════════════════════════════
  //  侵入式编辑
  // ════════════════════════════════════════════

  /** 计算选中文本在文档中的起始行号（用于内文排序）；occurrence 为同文本第几处出现（0-based） */
  private computeLine(content: string | null, selection: string, editor: Editor | null, occurrence = 0): number | undefined {
    if (editor) {
      const from = editor.getCursor('from');
      if (from) return from.line;
    }
    if (content) {
      // 跳过 frontmatter：description 复述导语时避免行号定位到 YAML
      const bodyStart = getBodyStartOffset(content);
      const idx = findNthIndex(content, selection, occurrence + 1, bodyStart);
      if (idx >= 0) {
        return content.slice(0, idx).split('\n').length - 1;
      }
    }
    return undefined;
  }

  private async addHighlight(selection: string, editor: Editor | null, inReadingMode: boolean, occurrence = 0) {

    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) {

      return;
    }

    let content: string | null = null;
    if (inReadingMode) {
      content = await this.plugin.app.vault.read(file);



      // 防重复包裹：用户所选的那一处出现若已被 == 包裹则跳过文件修改
      // （仅检查正文；按已包裹数量与 occurrence 比较，避免选中后一处时被前处的包裹误判）
      const bodyStart = getBodyStartOffset(content);
      const wrappedMatches = content.slice(bodyStart).match(new RegExp(`==\\s*${escapeRegex(selection.trim())}\\s*==`, 'g'));
      const alreadyWrapped = !!wrappedMatches && wrappedMatches.length > occurrence;
      if (alreadyWrapped) {

        await this.plugin.store.addAnnotation(file.path, {
          id: this.plugin.generateId(),
          type: 'highlight',
          text: selection,
          color: '#FFC107',
          line: this.computeLine(content, selection, editor, occurrence),
          occurrence,
          createdAt: Date.now(),
        });
        this.plugin.refreshSidebar();
        new Notice('该文本已高亮');
        return;
      }

      // 跨段落选区：每段分别包裹 ==，因为 Obsidian ==高亮== 不能跨段落；
      // 跨 ** / ~~ 边界的选区把未配对标记留在 == 之外，避免畸形嵌套无法渲染
      const wrapHighlight = (origMatched: string) => wrapSegmented(origMatched, seg => `==${seg}==`);
      const updated = findAndReplace(content, selection, wrapHighlight, occurrence);


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
      line: this.computeLine(content, selection, editor, occurrence),
      occurrence,
      createdAt: Date.now(),
    });

    this.plugin.refreshSidebar();
    new Notice('已添加高亮');

    // 强制注入气泡
    setTimeout(() => this.forceInject(), 500);
  }

  private async addUnderline(selection: string, editor: Editor | null, inReadingMode: boolean, occurrence = 0) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;

    const underlineColor = this.plugin.settings.underlineColor || '#E8590C';
    const wrapPrefix = `<u style="color:${underlineColor}">`;
    const wrapSuffix = '</u>';

    let content: string | null = null;
    if (inReadingMode) {
      content = await this.plugin.app.vault.read(file);
      // <u> 也不能跨段落，每段分别包裹；跨 ** / ~~ 边界时未配对标记留在包裹外
      const wrapUnderline = (origMatched: string) => wrapSegmented(origMatched, seg => `${wrapPrefix}${seg}${wrapSuffix}`);
      const updated = findAndReplace(content, selection, wrapUnderline, occurrence);
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
      line: this.computeLine(content, selection, editor, occurrence),
      occurrence,
      createdAt: Date.now(),
    });

    this.plugin.refreshSidebar();
    new Notice('已添加划线');
  }

  /** 显示批注输入弹窗 */
  private showCommentModal(selection: string, editor: Editor | null, inReadingMode: boolean, occurrence = 0) {
    const modal = new CommentModal(this.plugin, selection, async (comment) => {
      await this.saveComment(selection, comment, editor, inReadingMode, occurrence);
    });
    modal.open();
  }

  private async saveComment(selection: string, comment: string, editor: Editor | null, inReadingMode: boolean, occurrence = 0) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) return;

    let content: string | null = null;
    if (inReadingMode) {
      content = await this.plugin.app.vault.read(file);
      // 批注 = 高亮 + 内联注释：==文本==%% 批注 %%；跨段落拆分，跨 ** / ~~ 边界时未配对标记留在包裹外
      const wrapComment = (origMatched: string) => wrapSegmented(origMatched, seg => `==${seg}==%% ${comment} %%`);
      const updated = findAndReplace(content, selection, wrapComment, occurrence);
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
      line: this.computeLine(content, selection, editor, occurrence),
      occurrence,
      createdAt: Date.now(),
    });

    this.plugin.refreshSidebar();
    new Notice('已添加批注');

    // 延迟注入气泡（等待 DOM 更新）
    setTimeout(() => this.forceInject(), 500);
  }

  // ═══════════════════════════════════════════
  //  复制
  // ═══════════════════════════════════════════

  /** 复制文本到剪贴板（优先 Clipboard API，失败回退 execCommand） */
  private async copyText(text: string) {
    if (!text) return;
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setCssStyles({ position: 'fixed', top: '0', left: '0', opacity: '0' });
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        new Notice(ok ? '已复制' : '复制失败');
      } catch {
        new Notice('复制失败');
      }
    };

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        new Notice('已复制');
        return;
      }
      fallback();
    } catch {
      fallback();
    }
  }

  // ═══════════════════════════════════════════
  //  侧边栏定位（对齐 FleurPDF：滚动居中 + 闪烁）
  // ═══════════════════════════════════════════

  /** 定位指示器（overlay 方框）的 DOM 与清理句柄 */
  private locateOverlay: HTMLElement | null = null;
  private locateOverlayTimer: ReturnType<typeof setTimeout> | null = null;
  private locateScrollTimer: ReturnType<typeof setTimeout> | null = null;
  private locateScrollHandler: (() => void) | null = null;
  private lastRevealId = '';
  private lastRevealAt = 0;

  /**
   * 从侧边栏定位到原文中的标注。按成本从低到高依次尝试，命中即返回：
   * 0) data-fleur-annotation 属性精确匹配（注入过批注气泡的标注）
   * 1) mark / .cm-highlight / u 渲染文本多级匹配（精确 → 包含 → 前缀 → 相似度）
   * 2) 块级元素兜底（包含目标的最短块）
   * 3) 阅读模式懒渲染兜底：比例滚动跳转 → 短帧轮询重试
   * 4) 编辑模式按行号 setCursor + scrollIntoView
   */
  async revealAnnotation(ann: Annotation) {
    // 去抖：双击会先派发两次 click，连点也常见；同一条批注 400ms 内只定位一次
    const now = Date.now();
    if (this.lastRevealId === ann.id && now - this.lastRevealAt < 400) return;
    this.lastRevealId = ann.id;
    this.lastRevealAt = now;

    try {
      await this.revealAnnotationInner(ann);
    } catch (e) {
      console.error('[FleurAnnotation] revealAnnotation failed:', e);
      new Notice('定位时发生异常：' + String(e));
    }
  }

  private async revealAnnotationInner(ann: Annotation) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) {
      new Notice('未找到原文文件');
      return;
    }

    const target = normalizeForMatch(ann.text || '');

    // 搜索根 + 目标视图：按文件路径在所有 markdown leaf 中查找。
    // 不用 getActiveViewOfType——点击侧边栏后焦点在侧边栏上，活动视图不是笔记视图。
    // 关键：优先「可见」的视图。剪辑/切换模式后，DOM 里常残留隐藏的源码视图，
    // 其中的 .cm-highlight 高宽为 0，命中它等于什么都没发生（曾表现为「点了无法定位」）。
    type Candidate = { view: MarkdownView; el: HTMLElement; visible: boolean; active: boolean };
    const candidates: Candidate[] = [];
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view as MarkdownView;
      if (!v?.file || v.file.path !== file.path) continue;
      const el = (v as unknown as { containerEl?: HTMLElement }).containerEl;
      if (!el) continue;
      candidates.push({ view: v, el, visible: isVisible(el), active: leaf === activeLeaf });
    }
    candidates.sort((a, b) => Number(b.visible) - Number(a.visible) || Number(b.active) - Number(a.active));

    const visibleCandidates = candidates.filter(c => c.visible);
    const useCandidates = visibleCandidates.length ? visibleCandidates : candidates;
    const noteView: MarkdownView | null = useCandidates[0]?.view ?? null;
    const roots: HTMLElement[] = useCandidates.map(c => c.el);
    const mode = noteView?.getMode();

    const level = { value: 0 };
    let hit: HTMLElement | null = null;
    let jumped = false;

    // 1) Live Preview / 源码模式：编辑器行号定位最可靠（DOM 只渲染视口附近的行，
    //    视口外的 .cm-highlight 即使存在也是零高度，滚动它没有任何效果）
    const editor = noteView?.editor;
    if (editor && mode === 'source' && typeof ann.line === 'number') {
      const line = this.resolveEditorLine(editor, ann);
      if (line !== null) {
        editor.setCursor({ line, ch: 0 });
        editor.scrollIntoView(
          { from: { line, ch: 0 }, to: { line: Math.min(line + 1, editor.lineCount() - 1), ch: 0 } },
          true
        );
        // 滚动到该行后，视口内的标注已渲染，再给高亮本体一个轻指示（保持一致体验）
        if (target) {
          window.setTimeout(() => {
            const mark = this.findAnnotationElement(ann, target, roots, { value: 0 });
            if (mark && isVisible(mark)) this.flashLocate(mark, ann.text);
          }, 90);
        }
        return;
      }
    }

    // 2) DOM 文本匹配（只扫可见视图）
    hit = this.findAnnotationElement(ann, target, roots, level);

    // 命中零高度元素（隐藏视图残留）等于没定位：视作未命中，继续走懒渲染兜底
    if (hit && !isVisible(hit)) hit = null;

    // 阅读模式懒渲染兜底：阅读视图按分区懒加载，未滚动到的段落不在 DOM 里，
    // 文本匹配必然失败。按行号比例跳转 + 短轮询重试。
    // 注意：不用 setEphemeralState({line})——它会触发 Obsidian 内置的「目标块闪烁」
    // 动画（背景取 --text-highlight-bg，整段泛粉约一秒），观感像全段被高亮。
    // applyScroll 只改 scrollTop 无副作用；命中后由 revealElement 精确居中，精度无损。
    if (
      !hit &&
      target &&
      noteView &&
      mode === 'preview' &&
      typeof ann.line === 'number' &&
      ann.line >= 0
    ) {
      const preview = noteView.previewMode;
      const content = await this.plugin.app.vault.cachedRead(file);
      const totalLines = Math.max(content.split('\n').length, 1);
      const frac = Math.min(Math.max(ann.line / totalLines, 0), 0.999);
      const fractions = [
        frac,
        Math.min(frac + 0.06, 0.999),
        Math.max(frac - 0.06, 0),
        Math.min(frac + 0.12, 0.999),
        Math.max(frac - 0.12, 0),
      ];
      for (const f of fractions) {
        this.scrollPreviewToFraction(preview, f);
        hit = await this.pollFindAnnotation(ann, target, roots, level, 3, 80);
        if (hit) break;
      }
      jumped = true;
    }

    if (hit) {
      this.revealElement(hit, noteView);
      this.flashLocate(hit, ann.text);
      return;
    }

    // 注意：阅读模式下 view.editor 仍然存在，但视口里没有编辑器 DOM，
    // setCursor 不会有任何视觉反馈——所以这里不再用编辑器兜底，避免「静默假成功」。

    new Notice('未能在原文中定位到该标注');
  }

  /**
   * 在给定根容器中查找标注元素：
   * data 属性精确匹配 → mark/.cm-highlight/u 文本多级匹配 → 块级元素兜底（含目标的最短块）
   * level.value 回传命中方式：9=属性 4=精确 3=包含 2=前缀 1=相似度 -1=块级兜底
   *
   * 关键：同一容器内可能同时存在阅读模式（mark）与残留源码视图（.cm-highlight，零高度）。
   * 先按文本筛出候选（纯字符串计算，不触发重排），再优先返回「可见」的那个，
   * 避免命中隐藏元素导致「点了没反应」。
   */
  private findAnnotationElement(
    ann: Annotation,
    target: string,
    roots: HTMLElement[],
    level: { value: number }
  ): HTMLElement | null {
    for (const root of roots) {
      // 0) 已注入 data 属性的（带批注的标注）
      const byId = root.querySelector(`[data-fleur-annotation="${ann.id}"]`) as HTMLElement | null;
      if (byId) {
        level.value = 9;
        return byId;
      }
    }
    if (!target) return null;

    // 1) 渲染后的标注元素文本匹配（先筛候选，再按可见性择优）
    const markHits: { el: HTMLElement; lv: number }[] = [];
    for (const root of roots) {
      for (const m of Array.from(root.querySelectorAll('mark, .cm-highlight, u'))) {
        const lv = matchLevel(normalizeForMatch(m.textContent || ''), target);
        if (lv > 0) markHits.push({ el: m as HTMLElement, lv });
      }
    }
    markHits.sort((a, b) => b.lv - a.lv);
    for (const c of markHits) {
      if (isVisible(c.el)) {
        level.value = c.lv;
        return c.el;
      }
    }
    if (markHits.length) {
      // 全部不可见：交回上层判定（会视作未命中并继续兜底）
      level.value = markHits[0].lv;
      return markHits[0].el;
    }

    // 2) 块级元素兜底：找「包含目标且文本最短」的可见块——即使 mark 没渲染出来，也能落到所在段落
    const blockHits: { el: HTMLElement; len: number }[] = [];
    for (const root of roots) {
      const blocks = root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, .cm-line');
      for (const b of Array.from(blocks)) {
        const t = normalizeForMatch(b.textContent || '');
        if (t && t.includes(target)) blockHits.push({ el: b as HTMLElement, len: t.length });
      }
    }
    blockHits.sort((a, b) => a.len - b.len);
    const best = blockHits.find(c => isVisible(c.el)) ?? blockHits[0] ?? null;
    if (best) level.value = -1;
    return best?.el ?? null;
  }

  /** 短帧轮询匹配：等懒渲染推进后重试，命中即返回（避免长等待造成的卡顿感） */
  private async pollFindAnnotation(
    ann: Annotation,
    target: string,
    roots: HTMLElement[],
    level: { value: number },
    times: number,
    intervalMs: number
  ): Promise<HTMLElement | null> {
    for (let i = 0; i < times; i++) {
      await new Promise<void>(r => setTimeout(r, intervalMs));
      const hit = this.findAnnotationElement(ann, target, roots, level);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 编辑器行号校正：批注创建后笔记可能被编辑，记录的行号会偏移。
   * 以记录行号为锚点，在 ±10 行内用文本片段校验，返回真正包含该文本的行。
   */
  private resolveEditorLine(editor: Editor, ann: Annotation): number | null {
    const total = editor.lineCount();
    const base = typeof ann.line === 'number' ? ann.line : -1;
    if (base < 0) return null;

    const candidates: number[] = [];
    if (base < total) candidates.push(base);
    for (let d = 1; d <= 10; d++) {
      if (base - d >= 0) candidates.push(base - d);
      if (base + d < total) candidates.push(base + d);
    }

    const probe = normalizeForMatch((ann.text || '').slice(0, 20));
    if (probe.length >= 6) {
      for (const l of candidates) {
        if (normalizeForMatch(editor.getLine(l)).includes(probe)) return l;
      }
    }
    return base < total ? base : null;
  }

  /** 让目标元素进入视野：确保所在 leaf 可见 + 瞬时滚动最近的可滚动祖先（不用平滑滚动，避免延迟感） */
  private revealElement(el: HTMLElement, view: MarkdownView | null) {
    if (view) {
      const leaf = this.plugin.app.workspace
        .getLeavesOfType('markdown')
        .find(l => l.view === view);
      if (leaf && this.plugin.app.workspace.activeLeaf !== leaf) {
        try {
          this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
        } catch { /* 忽略：API 版本差异 */ }
      }
    }
    const scroller = findScrollParent(el);
    if (scroller) {
      const r = el.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const delta = r.top - sr.top - (sr.height / 2 - r.height / 2);
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
    } else {
      el.scrollIntoView({ block: 'center' });
    }
  }

  /** 将阅读视图滚动到指定比例位置（0-1） */
  private scrollPreviewToFraction(preview: MarkdownPreviewView, frac: number) {
    const scroller = this.findPreviewScroller(preview.containerEl);
    if (scroller) {
      scroller.scrollTop = frac * Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
      return;
    }
    // 找不到可滚动容器时才依赖官方 API（applyScroll 只是设比例，历史上有不生效的版本）
    const anyPreview = preview as unknown as { applyScroll?: (n: number) => void };
    if (typeof anyPreview.applyScroll === 'function') {
      anyPreview.applyScroll(frac);
    }
  }

  /**
   * 找阅读模式下真正可滚动的容器。
   * 关键：不能猜类名——直接选「scrollHeight 明显大于 clientHeight」的后代；
   * 新版 Obsidian 的滚动容器在 .markdown-preview-view 或 .markdown-reading-view 上，
   * 两者都可能随版本变化，所以最后兜底为全后代里 scrollHeight 差最大的元素。
   */
  private findPreviewScroller(root: HTMLElement): HTMLElement | null {
    const sels = ['.markdown-preview-view', '.markdown-reading-view'];
    for (const s of sels) {
      const el = root.querySelector(s) as HTMLElement | null;
      if (el && el.scrollHeight - el.clientHeight > 10) return el;
    }
    if (root.scrollHeight - root.clientHeight > 10) return root;
    let best: HTMLElement | null = null;
    let bestDelta = 0;
    root.querySelectorAll('*').forEach(el => {
      const h = el as HTMLElement;
      const d = h.scrollHeight - h.clientHeight;
      if (d > bestDelta) {
        bestDelta = d;
        best = h;
      }
    });
    return best;
  }

  /**
   * 在元素内按文本定位 Range 并取矩形：跨行 inline 元素会返回「每行一个」矩形，
   * 因此可以画出贴合文字的方框，而不是把长文本框成一个跨行大块。
   */
  private textRectsIn(el: HTMLElement, text: string): DOMRect[] {
    if (!text) return [];
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const segs: { node: Text; start: number }[] = [];
      let full = '';
      let n = walker.nextNode() as Text | null;
      while (n) {
        segs.push({ node: n, start: full.length });
        full += n.data;
        n = walker.nextNode() as Text | null;
      }
      if (!full) return [];
      let needle = text;
      let idx = full.indexOf(needle);
      if (idx < 0) {
        needle = text.trim();
        idx = needle ? full.indexOf(needle) : -1;
      }
      if (idx < 0 || !needle) return [];

      const locate = (pos: number): { node: Text; offset: number } | null => {
        for (let i = segs.length - 1; i >= 0; i--) {
          if (pos >= segs[i].start) {
            return { node: segs[i].node, offset: Math.min(pos - segs[i].start, segs[i].node.data.length) };
          }
        }
        return segs.length ? { node: segs[0].node, offset: 0 } : null;
      };
      const a = locate(idx);
      const b = locate(idx + needle.length);
      if (!a || !b) return [];

      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return Array.from(range.getClientRects()).filter(r => r.width > 2 && r.height > 2);
    } catch {
      return [];
    }
  }

  /** 把矩形按行合并（同一视觉行上的碎片合成一段），过滤零尺寸 */
  private mergeLineRects(rects: DOMRect[]): { left: number; top: number; width: number; height: number }[] {
    const items = rects
      .filter(r => r.width > 2 && r.height > 2)
      .map(r => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const out: { left: number; top: number; right: number; bottom: number }[] = [];
    for (const it of items) {
      const last = out[out.length - 1];
      const sameLine = last && Math.abs(it.top - last.top) < Math.max(last.bottom - last.top, 1) * 0.6;
      const adjacent = last && it.left - last.right < 40;
      if (sameLine && adjacent) {
        last.right = Math.max(last.right, it.right);
        last.bottom = Math.max(last.bottom, it.bottom);
      } else {
        out.push({ ...it });
      }
    }
    return out.map(r => ({ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top }));
  }

  /** 计算定位框：优先按批注文本精确取矩形，退回元素自身矩形 */
  private measureLocateRects(el: HTMLElement, text?: string) {
    // 命中带 data 属性的容器时，用其内部的高亮/划线本体来测量，避免把气泡一起框进去
    const inner = el.querySelector('mark, .cm-highlight, u') as HTMLElement | null;
    const measureEl = inner && isVisible(inner) ? inner : el;

    const byText = text ? this.textRectsIn(measureEl, text) : [];
    if (byText.length) return this.mergeLineRects(byText);

    const self = Array.from(measureEl.getClientRects());
    return this.mergeLineRects(self);
  }

  /** 清除定位指示器（方框 + 滚动监听 + 定时器） */
  private clearLocateIndicator() {
    if (this.locateOverlayTimer) {
      clearTimeout(this.locateOverlayTimer);
      this.locateOverlayTimer = null;
    }
    if (this.locateScrollTimer) {
      clearTimeout(this.locateScrollTimer);
      this.locateScrollTimer = null;
    }
    if (this.locateScrollHandler) {
      window.removeEventListener('scroll', this.locateScrollHandler, true);
      this.locateScrollHandler = null;
    }
    if (this.locateOverlay) {
      this.locateOverlay.remove();
      this.locateOverlay = null;
    }
  }

  /**
   * 定位指示：在命中文字外围画一圈方框（逐行贴合），短暂停驻后淡出。
   * 用 overlay 绝对定位绘制而非 CSS outline —— outline 会把跨多行的 inline 元素
   * 画成一个横跨所有行的大外框，长批注看起来像「整段被框住」。
   */
  private flashLocate(el: HTMLElement, text?: string) {
    this.clearLocateIndicator();

    const rects = this.measureLocateRects(el, text);
    if (!rects.length) return;

    const overlay = document.body.createDiv({ cls: 'fleur-locate-overlay' });
    for (const r of rects) {
      const box = overlay.createDiv({ cls: 'fleur-locate-box' });
      const props: Record<string, string> = {
        '--locate-x': `${Math.round(r.left - 3)}px`,
        '--locate-y': `${Math.round(r.top - 2)}px`,
        '--locate-w': `${Math.round(r.width + 6)}px`,
        '--locate-h': `${Math.round(r.height + 4)}px`,
      };
      const anyBox = box as unknown as { setCssProps?: (p: Record<string, string>) => void };
      if (typeof anyBox.setCssProps === 'function') {
        anyBox.setCssProps(props);
      } else {
        box.setCssStyles({
          left: props['--locate-x'],
          top: props['--locate-y'],
          width: props['--locate-w'],
          height: props['--locate-h'],
        });
      }
    }
    this.locateOverlay = overlay;

    // 方框用视口坐标绘制，滚动后必然错位——一旦滚动立即清除。
    // 但定位流程自身的程序化滚动（行号跳转 / 居中滚动）触发的 scroll 事件
    // 会在绘制之后才到达，立即监听会把刚画的框自己清掉——表现为「要点两次才出框」。
    // 因此延迟挂载避开滚动余波；此后用户手动滚动仍会即时清除。
    const onScroll = () => this.clearLocateIndicator();
    this.locateScrollTimer = setTimeout(() => {
      if (!this.locateOverlay) return;
      this.locateScrollHandler = onScroll;
      window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    }, 300);

    this.locateOverlayTimer = setTimeout(() => this.clearLocateIndicator(), 1600);
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

  /**
   * 将 AI 回复写入当前选中原文对应的批注（AI 面板「写入批注」按钮）：
   * - 批注内容剥离 Markdown，按纯文本写入（与批注展示约定一致）
   * - 选中原文已有批注 → 更新批注内容（文件内旧 %%…%% 标记同步替换）
   * - 没有对应批注 → 走现有「添加批注」逻辑新建（==文本==%% 批注 %%）
   * @returns 是否写入成功
   */
  async writeAIAnnotation(selectedText: string, aiContent: string): Promise<boolean> {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) {
      new Notice('请先打开一个笔记');
      return false;
    }

    const comment = stripMarkdown(aiContent || '').trim();
    if (!comment) {
      new Notice('AI 内容为空，无法写入批注');
      return false;
    }

    const norm = (s: string) => s.replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF]+/g, '').toLowerCase();
    const target = norm(selectedText);

    const data = await this.plugin.store.load(file.path);
    const ann = data.annotations.find(a => {
      const t = norm(a.text || '');
      return t && (t === target || t.includes(target) || target.includes(t));
    });

    if (ann) {
      // 更新现有批注：文件内的旧 %%…%% 标记替换为新的
      const content = await this.plugin.app.vault.read(file);
      let updated = content;

      if (ann.comment) {
        const markers = [`%% ${ann.comment} %%`, `%%${ann.comment}%%`];
        for (const m of markers) {
          if (updated.includes(m)) {
            updated = updated.replace(m, `%% ${comment} %%`);
            break;
          }
        }
      }

      // 旧标记不在文件中（或原本无批注）→ 在原文标记后追加新批注标记
      if (updated === content) {
        const appended = this.appendCommentMarker(content, ann.text, ann.type, ann.color, comment, ann.occurrence ?? 0);
        if (appended === null) {
          new Notice('未能在原文中定位到该标注，仅写入侧边栏');
        }
        updated = appended ?? content;
      }

      if (updated !== content) {
        await this.plugin.app.vault.modify(file, updated);
      }

      ann.comment = comment;
      await this.plugin.store.updateAnnotation(file.path, ann);

      this.plugin.refreshSidebar();
      new Notice('已写入批注');
      setTimeout(() => this.forceInject(), 500);
      return true;
    }

    // 没有对应批注 → 新建（与「添加批注」一致：高亮 + 内联批注）
    await this.saveComment(selectedText, comment, null, true);
    return true;
  }

  /** 在原文（或其包裹标记）后追加 %% 批注 %% 标记，找不到原文返回 null；occurrence 定位同文本的第几处出现 */
  private appendCommentMarker(
    content: string,
    text: string,
    type: string,
    color: string | undefined,
    comment: string,
    occurrence = 0
  ): string | null {
    const marker = `%% ${comment} %%`;

    // 候选插入点：高亮包裹后 → 划线包裹后 → 裸文本后
    // 统一从正文（跳过 frontmatter）开始查找，避免批注标记写进 YAML
    const searchFrom = getBodyStartOffset(content);
    const candidates: { anchor: string; offset: number }[] = [
      { anchor: `==${text}==`, offset: `==${text}==`.length },
    ];

    const underlineRegex = new RegExp(`<u[^>]*>${escapeRegex(text)}</u>`);
    const uMatch = content.slice(searchFrom).match(underlineRegex);
    if (uMatch && uMatch.index !== undefined) {
      candidates.push({ anchor: uMatch[0], offset: uMatch[0].length });
    }

    candidates.push({ anchor: text, offset: text.length });

    for (const c of candidates) {
      const idx = findNthIndex(content, c.anchor, occurrence + 1, searchFrom);
      if (idx !== -1) {
        const insertPos = idx + c.offset;
        return content.substring(0, insertPos) + marker + content.substring(insertPos);
      }
    }
    return null;
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
    this.plugin.refreshSidebar();
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
