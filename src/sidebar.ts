import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, Menu, TFile, MarkdownView } from 'obsidian';
import { stripMarkdown } from './editor';
import type FleurAnnotationPlugin from './main';
import type { Annotation } from './types';
import { AIChatPanel } from './ai-chat-modal';

// 辅助函数：从属性数组构建 SVG 图标
function makeIcon(parent: HTMLElement, size: number, children: Array<[string, Record<string, string>]>) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of children) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  parent.appendChild(svg);
}

export const VIEW_TYPE_FLEUR_NOTE = 'fleur-annotation-sidebar';

export class SidebarView extends ItemView {
  private data: { annotations: Annotation[] } = { annotations: [] };

  constructor(leaf: WorkspaceLeaf, private plugin: FleurAnnotationPlugin) {
    super(leaf);
  }

  getViewType() { return VIEW_TYPE_FLEUR_NOTE; }
  getDisplayText() { return 'FleurAnnotation'; }
  getIcon() { return 'feather'; }

  async onOpen() {
    await this.loadData();
    this.renderUI();
  }

  async onClose() {}

  /** 刷新侧边栏（重新加载数据并渲染） */
  async refresh() { await this.loadData(); this.renderUI(); }

  async refreshAnnotations() {
    // 删除操作可能触发了 view 重建，等一帧确保 DOM 就绪
    await new Promise(r => setTimeout(r, 50));
    await this.loadData();
    this.renderUI();
  }

  private lastFilePath: string | null = null;

  private async loadData() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      // 无活跃文件时，尝试用上次的文件路径加载
      if (this.lastFilePath) {
        try {
          this.data = await this.plugin.store.load(this.lastFilePath);
        } catch { /* keep existing data */ }
      }
      return;
    }
    this.lastFilePath = file.path;
    this.data = await this.plugin.store.load(file.path);
  }

  // ════════════════════════════════════════════
  //  UI 渲染（完全对标 FleurPDF 侧边栏）
  // ════════════════════════════════════════════

  private renderUI() {
    const container = this.contentEl;
    if (!container) return;
    container.empty();
    container.addClass('fleur-sidebar');

    // 顶部标题栏
    const header = container.createDiv();
    header.addClass('fleur-sidebar-header');
    const titleEl = header.createSpan({ text: '批注' });
    titleEl.addClass('fleur-sidebar-title');

    // 导出笔记按钮
    const exportBtn = header.createEl('button');
    exportBtn.addClass('fleur-sidebar-export-btn');
    makeIcon(exportBtn, 13, [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }], ['line', { x1: '12', y1: '18', x2: '12', y2: '12' }], ['polyline', { points: '9 15 12 18 15 15' }]]);
    exportBtn.createSpan({ text: ' 导出笔记' });
    exportBtn.addEventListener('click', () => this.exportAllNotes());

    // 内容区
    const body = container.createDiv();
    body.addClass('fleur-sidebar-body');

    if (this.data.annotations.length === 0) {
      const empty = body.createDiv({ text: '暂无批注，选中文本右键添加' });
      empty.addClass('fleur-sidebar-empty');
      return;
    }

    // 按类型分组
    const groups: { type: string; label: string; icon: string; items: Annotation[] }[] = [
      { type: 'highlight', label: '高亮', icon: 'highlighter', items: [] },
      { type: 'underline', label: '划线', icon: 'underline', items: [] },
      { type: 'comment', label: '批注', icon: 'message-square', items: [] },
    ];

    this.data.annotations.forEach(ann => {
      const g = groups.find(g => g.type === ann.type);
      if (g) g.items.push(ann);
    });

    groups.forEach(group => {
      if (group.items.length === 0) return;

      // 分组标题
      const section = body.createDiv();
      section.addClass('fleur-sidebar-section');

      const pageTag = section.createDiv();
      pageTag.addClass('fleur-sidebar-page-tag');
      makeIcon(pageTag, 12, [['path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }], ['path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' }]]);
      pageTag.createSpan({ text: ` ${group.label}（${group.items.length}）` });

      group.items.forEach(ann => {
        this.renderAnnotation(section, ann);
      });
    });
  }

  // ── 单条标注卡片（fleurPDF 风格） ──

  private renderAnnotation(parent: HTMLElement, ann: Annotation) {
    const card = parent.createDiv();
    card.addClass('fleur-card');

    // 顶部色条
    const bar = card.createDiv();
    const barColor = ann.type === 'underline'
      ? (ann.color || '#E8590C')
      : (ann.color || '#FFC107');
    bar.addClass('fleur-card-bar');
    bar.setCssStyles({ background: barColor });

    // 主体
    const main = card.createDiv();
    main.addClass('fleur-card-main');

    // 选中文本行
    const row = main.createDiv();
    row.addClass('fleur-card-row');

    // 类型图标
    const typeIcon = row.createDiv();
    typeIcon.addClass('fleur-card-type-icon');
    if (ann.type === 'highlight') {
      makeIcon(typeIcon, 14, [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' }]]);
    } else if (ann.type === 'underline') {
      makeIcon(typeIcon, 14, [['path', { d: 'M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3' }], ['line', { x1: '4', y1: '21', x2: '20', y2: '21' }]]);
    } else {
      makeIcon(typeIcon, 14, [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]]);
    }

    // 选中文本
    const textWrap = row.createDiv();
    textWrap.addClass('fleur-card-text-wrap');

    const textEl = textWrap.createDiv();
    let expanded = false;
    textEl.addClass('fleur-card-text');
    textEl.textContent = ann.text;
    textEl.title = '点击展开/收起';
    textEl.addEventListener('click', (e) => {
      e.stopPropagation();
      expanded = !expanded;
      textEl.toggleClass('is-expanded', expanded);
    });

    // 卡片右上角操作图标（始终显示，更简洁）
    const actions = row.createDiv();
    actions.addClass('fleur-card-actions');

    // AI 生成批注按钮
    const aiBtn = actions.createEl('button');
    aiBtn.title = 'AI 生成批注';
    aiBtn.addClass('fleur-card-ai-btn');
    const aiIconWrap = aiBtn.createSpan();
    makeIcon(aiIconWrap, 13, [['path', { d: 'M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22' }], ['path', { d: 'M12 2a4 4 0 0 0-4 4c0 1.95 1.4 3.58 3.25 3.93' }], ['path', { d: 'M8 6h8' }], ['path', { d: 'M9 10h6' }], ['path', { d: 'M10 14h4' }], ['path', { d: 'M11 18h2' }]]);
    aiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.generateAIComment(ann);
    });

    // 编辑按钮
    const editBtn = actions.createEl('button');
    editBtn.title = '编辑批注';
    editBtn.addClass('fleur-card-edit-btn');
    const editIconWrap = editBtn.createSpan();
    makeIcon(editIconWrap, 13, [['path', { d: 'M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' }]]);
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openInlineEditor(ann, main);
    });

    // 删除按钮
    const delBtn = actions.createEl('button');
    delBtn.title = '删除';
    delBtn.addClass('fleur-card-del-btn');
    const delIconWrap = delBtn.createSpan();
    makeIcon(delIconWrap, 13, [['line', { x1: '18', y1: '6', x2: '6', y2: '18' }], ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }]]);
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteAnnotation(ann);
    });

    // 批注区
    const commentSlot = main.createDiv();
    commentSlot.dataset['commentSlotFor'] = ann.id;

    if (ann.comment) {
      this.renderCommentDisplay(commentSlot, ann, main);
    } else {
      this.renderAddCommentHint(commentSlot, ann, main);
    }

    // 时间戳
    const footer = main.createDiv();
    footer.addClass('fleur-card-footer');
    footer.textContent = new Date(ann.createdAt).toLocaleString('zh-CN');
  }

  // ── 批注显示（原位编辑） ──

  private renderCommentDisplay(slot: HTMLElement, ann: Annotation, cardMain: HTMLElement) {
    slot.addClass('fleur-comment-slot');

    const display = slot.createDiv();
    display.addClass('fleur-comment-display');

    const commentText = stripMarkdown(ann.comment || '');
    display.textContent = commentText;
    display.title = '单击展开/收起，双击编辑';

    // 展开提示（文本超过80字时显示）
    let expanded = false;
    const toggleHint = slot.createDiv({ text: '展开全文 ›' });
    toggleHint.addClass('fleur-comment-toggle-hint');
    const needsToggle = commentText.length > 80;
    toggleHint.setCssStyles({ display: needsToggle ? '' : 'none' });
    toggleHint.addEventListener('click', (e) => {
      e.stopPropagation();
      expanded = !expanded;
      display.toggleClass('is-expanded', expanded);
      toggleHint.textContent = expanded ? '收起 ‹' : '展开全文 ›';
    });

    // 单击切换展开/收起
    display.addEventListener('click', (e) => {
      e.stopPropagation();
      expanded = !expanded;
      display.toggleClass('is-expanded', expanded);
      toggleHint.textContent = expanded ? '收起 ‹' : '展开全文 ›';
    });

    // 双击原位编辑
    display.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.openInlineEditor(ann, cardMain);
    });
  }

  private renderAddCommentHint(slot: HTMLElement, ann: Annotation, cardMain: HTMLElement) {
    slot.addClass('fleur-comment-slot');

    const hint = slot.createDiv({ text: '添加批注…' });
    hint.addClass('fleur-comment-hint');
    hint.addEventListener('click', () => this.openInlineEditor(ann, cardMain));
  }

  /** 原位编辑器：直接在批注位置替换为 textarea，Enter 保存，Esc/点击外部取消 */
  private openInlineEditor(ann: Annotation, cardMain: HTMLElement) {
    const slot = cardMain.querySelector(`[data-comment-slot-for="${ann.id}"]`);
    if (!slot) return;

    // 清除旧的编辑区
    const existing = slot.querySelector(`[data-comment-editor-for="${ann.id}"]`);
    if (existing) existing.remove();

    const editorWrap = slot.createDiv();
    editorWrap.dataset['commentEditorFor'] = ann.id;
    editorWrap.addClass('fleur-comment-editor-wrap');

    const textarea = editorWrap.createEl('textarea');
    textarea.value = ann.comment || '';
    textarea.addClass('fleur-comment-textarea');
    textarea.setCssStyles({ minHeight: '80px' });
    textarea.addEventListener('input', () => {
      textarea.setCssStyles({ height: 'auto' });
      textarea.setCssStyles({ height: `${Math.min(textarea.scrollHeight, 400)}px` });
    });

    // 隐藏批注显示和提示
    const display = slot.querySelector('.fleur-comment-display');
    const toggleHint = slot.querySelector('.fleur-comment-toggle-hint');
    if (display) (display as HTMLElement).setCssStyles({ display: 'none' });
    if (toggleHint) (toggleHint as HTMLElement).setCssStyles({ display: 'none' });

    // Enter 保存，Shift+Enter 换行，Esc 取消
    textarea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        saveComment();
      } else if (e.key === 'Escape') {
        cancelEdit();
      }
    });

    const doSave = async () => {
      ann.comment = textarea.value.trim();
      if (ann.comment) {
        await this.syncAnnotationToFile(ann);
      } else {
        await this.plugin.store.updateAnnotation(this.getFilePath(), ann);
      }
      await this.refreshAnnotations();
    };

    const saveComment = async () => {
      await doSave();
    };

    const cancelEdit = () => {
      editorWrap.remove();
      if (display) (display as HTMLElement).setCssStyles({ display: '' });
      if (toggleHint) (toggleHint as HTMLElement).setCssStyles({ display: '' });
    };

    // 底部保存/取消按钮行（小图标风格）
    const btnRow = editorWrap.createDiv();
    btnRow.addClass('fleur-comment-btn-row');

    const saveBtn = btnRow.createEl('button', { text: '保存' });
    saveBtn.addClass('fleur-comment-save-btn');
    saveBtn.addEventListener('click', saveComment);

    const cancelBtn = btnRow.createEl('button', { text: '取消' });
    cancelBtn.addClass('fleur-comment-cancel-btn');
    cancelBtn.addEventListener('click', cancelEdit);

    textarea.focus();
  }

  // ── AI 生成批注 ──

  private async generateAIComment(ann: Annotation) {
    ann.comment = '⏳ AI 正在生成批注…';
    await this.plugin.store.updateAnnotation(this.getFilePath(), ann);
    await this.refreshAnnotations();

      try {
        const { AIService } = await import('./ai-service');
        const service = new AIService(this.plugin);
        let result = '';

        await service.streamChat(
          [{ role: 'user', content: `请为以下文本生成一段简明批注（100-200字）。要求：1）概括核心观点；2）简析逻辑或论证方式；3）点出深层含义或影响。直接输出批注内容，不要加"批注："等前缀，不要使用 Markdown 格式。\n\n「${ann.text}」` }],
          (text) => { result += text; }
        );

        ann.comment = stripMarkdown(result || '生成失败');
        await this.plugin.store.updateAnnotation(this.getFilePath(), ann);
        await this.refreshAnnotations();
      } catch (err) {
        ann.comment = '生成失败：' + (err as Error).message;
        await this.plugin.store.updateAnnotation(this.getFilePath(), ann);
        await this.refreshAnnotations();
      }
  }

  // ─ 删除 ──

  private async deleteAnnotation(ann: Annotation) {
    await this.plugin.patcher.deleteAnnotation(ann.id);
  }

  // ── 导出 ──

  private async exportAllNotes() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('请先打开一个 Markdown 文件'); return; }

    const lines: string[] = [`# ${file.basename} 批注导出`, '', `> 导出时间：${new Date().toLocaleString('zh-CN')}`, ''];

    const types: { type: string; label: string }[] = [
      { type: 'highlight', label: '📝 高亮' },
      { type: 'underline', label: '📏 划线' },
      { type: 'comment', label: '💬 批注' },
    ];

    for (const g of types) {
      const items = this.data.annotations.filter(a => a.type === g.type);
      if (items.length === 0) continue;

      lines.push(`## ${g.label}（${items.length}条）`, '');
      items.forEach(ann => {
        lines.push(`- **${ann.text}**`);
        if (ann.comment) lines.push(`  > ${ann.comment}`);
        lines.push(`  _${new Date(ann.createdAt).toLocaleString('zh-CN')}_`, '');
      });
    }

    const exportFolder = this.plugin.settings.noteFolder || 'FleurAnnotation';
    await this.app.vault.createFolder(exportFolder).catch(() => {});

    const outPath = `${exportFolder}/${file.basename}-批注.md`;
    await this.app.vault.create(outPath, lines.join('\n'));
    new Notice(`已导出到 ${outPath}`);
  }

  private getFilePath(): string {
    return this.app.workspace.getActiveFile()?.path || '';
  }

  /** 把批注数据同步写入 markdown 文件，确保 DOM 中有对应的标记元素 */
  private async syncAnnotationToFile(ann: Annotation) {
    const filePath = this.getFilePath();
    if (!filePath) return;

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);

    // 根据类型生成要写入文件的标记
    let marker: string | null = null;

    if (ann.type === 'highlight') {
      const wrapped = `==${ann.text}==`;
      if (content.includes(wrapped)) {
        await this.plugin.store.updateAnnotation(filePath, ann);
        return;
      }
      marker = wrapped;
    } else if (ann.type === 'underline') {
      const color = ann.color || '#E8590C';
      const wrapped = `<u style="color:${color}">${ann.text}</u>`;
      if (content.includes(wrapped)) {
        await this.plugin.store.updateAnnotation(filePath, ann);
        return;
      }
      marker = wrapped;
    } else if (ann.type === 'comment') {
      if (ann.comment) {
        const commentMarker = `%% ${ann.comment} %%`;
        if (content.includes(commentMarker) || content.includes(`%%${ann.comment}%%`)) {
          await this.plugin.store.updateAnnotation(filePath, ann);
          return;
        }
        marker = commentMarker;
      }
    }

    if (!marker) {
      await this.plugin.store.updateAnnotation(filePath, ann);
      return;
    }

    // 在批注文本后面追加标记
    const idx = content.indexOf(ann.text);
    if (idx === -1) {
      await this.plugin.store.updateAnnotation(filePath, ann);
      return;
    }

    const before = content.substring(0, idx + ann.text.length);
    const after = content.substring(idx + ann.text.length);
    await this.app.vault.modify(file, before + marker + after);
    await this.plugin.store.updateAnnotation(filePath, ann);

    // 刷新视图保持在当前模式
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    const leaf = leaves.find(l => (l.view as any)?.file?.path === filePath);
    const currentMode = leaf?.view instanceof MarkdownView
      ? (leaf.view as MarkdownView).getMode()
      : 'preview';
    leaf?.setViewState({
      type: 'markdown',
      state: { file: filePath, mode: currentMode }
    });

    // 延迟注入气泡
    setTimeout(() => this.plugin.patcher?.forceInject?.(), 600);
  }
}
