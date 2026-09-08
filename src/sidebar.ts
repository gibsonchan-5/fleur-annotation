import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, Menu, TFile, MarkdownView } from 'obsidian';
import { stripMarkdown } from './editor';
import { resolveSystemPrompt } from './ai-prompts';
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

/** 与 FleurPDF 对齐：按背景色亮度挑选黑/白前景，保证高亮文字可读 */
function pickReadableFg(bg: string): string {
  const hex = bg.replace('#', '');
  if (hex.length !== 3 && hex.length !== 6) return '#000';
  const r = parseInt(hex.length === 3 ? hex[0] + hex[0] : hex.slice(0, 2), 16);
  const g = parseInt(hex.length === 3 ? hex[1] + hex[1] : hex.slice(2, 4), 16);
  const b = parseInt(hex.length === 3 ? hex[2] + hex[2] : hex.slice(4, 6), 16);
  // sRGB 相对亮度阈值 0.6 经验值（黑/白分明）
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? '#000' : '#fff';
}

/** 导出为 HTML 内联片段前的转义，避免正文里的 < > & 破坏标签 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const VIEW_TYPE_FLEUR_NOTE = 'fleur-annotation-sidebar';

export class SidebarView extends ItemView {
  private data: { annotations: Annotation[] } = { annotations: [] };

  constructor(leaf: WorkspaceLeaf, private plugin: FleurAnnotationPlugin) {
    super(leaf);
  }

  getViewType() { return VIEW_TYPE_FLEUR_NOTE; }
  getDisplayText() { return this.app.workspace.getActiveFile()?.basename || '批注'; }
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

    // 顶部标题栏（Obsidian 标签已显示文件名，这里只显示简洁的"批注"）
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

    // 按设置排序：内文顺序（行号升序）或时间倒序
    const sortMode = this.plugin.settings.annotationSort || 'line';
    const sorted = [...this.data.annotations].sort((a, b) => {
      if (sortMode === 'time') {
        return b.createdAt - a.createdAt;
      }
      // 内文顺序：优先行号，行号缺失或相同时退回时间
      const la = a.line ?? Number.MAX_SAFE_INTEGER;
      const lb = b.line ?? Number.MAX_SAFE_INTEGER;
      if (la !== lb) return la - lb;
      return a.createdAt - b.createdAt;
    });
    sorted.forEach(ann => {
      this.renderAnnotation(body, ann);
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

    // 卡片主体点击 → 定位到原文（对齐 FleurPDF 的定位能力）
    // 文本区、批注区、操作按钮均有 stopPropagation，不会误触发
    main.addEventListener('click', () => {
      void this.plugin.patcher.revealAnnotation(ann);
    });

    // 卡片右上角操作图标（定位/AI/编辑/删除）
    const actions = row.createDiv();
    actions.addClass('fleur-card-actions');

    // 定位按钮：滚动到原文并闪烁该标注
    const locateBtn = actions.createEl('button');
    locateBtn.title = '定位到原文';
    locateBtn.addClass('fleur-card-locate-btn');
    makeIcon(locateBtn, 13, [['path', { d: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z' }], ['circle', { cx: '12', cy: '10', r: '3' }]]);
    locateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.plugin.patcher.revealAnnotation(ann);
    });

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
    hint.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openInlineEditor(ann, cardMain);
    });
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
    // 阻止冒泡到卡片主体，避免编辑时误触发定位
    editorWrap.addEventListener('click', (e) => e.stopPropagation());

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

        // 系统提示词：按设置的「提示词模式」取用，自定义模式用对应槽位的内容。
        // 侧边栏是批注场景，需要精炼 → 追加字数约束；原文过长时上限自动放宽。
        const systemPrompt = resolveSystemPrompt(
          this.plugin.settings.promptPreset,
          this.plugin.settings.customPrompts,
          {
            applyLimit: true,
            sourceTextLength: ann.text.length,
            baseLimit: this.plugin.settings.annotationLimit,
          }
        );

        await service.streamChat(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `请为以下选中文本生成批注：\n\n「${ann.text}」` },
          ],
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
    try {
      const file = this.app.workspace.getActiveFile();
      if (!file) { new Notice('请先打开一个 Markdown 文件'); return; }

      if (this.data.annotations.length === 0) {
        new Notice('当前文件暂无批注可导出');
        return;
      }

      const lines: string[] = [];

      // ── frontmatter（自动标签 + 元信息） ──
      const tags = (this.plugin.settings.exportTags || 'fleur-annotation,批注导出')
        .split(/[,，\s]+/)
        .map(t => t.trim())
        .filter(Boolean);
      lines.push('---');
      lines.push(`tags: [${tags.join(', ')}]`);
      lines.push(`source: "${file.path.replace(/"/g, '\\"')}"`);
      lines.push(`exported: ${new Date().toISOString().split('T')[0]}`);
      // ── 元信息（callout 风格，Obsidian 渲染时自动灰色背景） ──
      // 注：不再生成插件内部 H1 标题，避免与 Obsidian 文件名标题重复
      const counts = {
        highlight: this.data.annotations.filter(a => a.type === 'highlight').length,
        underline: this.data.annotations.filter(a => a.type === 'underline').length,
        comment: this.data.annotations.filter(a => a.type === 'comment').length,
      };
      lines.push('---', '');
      lines.push('> [!info] 导出信息', '');
      lines.push(`> **🔗 原笔记：** [[${file.basename}]]`);
      lines.push(`> **📅 导出时间：** ${new Date().toLocaleString('zh-CN')}`);
      lines.push(`> **📊 统计：** 高亮 ${counts.highlight} 条 · 划线 ${counts.underline} 条 · 批注 ${counts.comment} 条`, '');

      // ── 三个分组 ──
      const groups: { type: string; label: string; icon: string }[] = [
        { type: 'highlight', label: '高亮', icon: 'highlighter' },
        { type: 'underline', label: '划线', icon: 'underline' },
        { type: 'comment', label: '批注', icon: 'message-square' },
      ];

      for (const g of groups) {
        const items = this.data.annotations.filter(a => a.type === g.type);
        if (items.length === 0) continue;

        lines.push('---', '');
        lines.push(`## ${g.label}（${items.length} 条）`, '');

        items.forEach((ann, idx) => {
          const cleanText = stripMarkdown(ann.text || '').trim();
          // 内联 span 渲染：换行收敛为空格，避免 HTML 片段被段落切断
          const inlineText = cleanText.replace(/\s*\n\s*/g, ' ').trim();
          const cleanComment = stripMarkdown(ann.comment || '').trim();
          const time = new Date(ann.createdAt).toLocaleString('zh-CN');

          // 与 FleurPDF 导出格式对齐：
          // 高亮 → 保留具体底色；划线 → 保留下划线颜色与线型（wavy 为波浪线）
          let display = escapeHtml(inlineText);
          if (ann.type === 'highlight') {
            const hlColor = ann.color || this.plugin.settings.highlightColor || '#FFD43B';
            const fg = pickReadableFg(hlColor);
            display = `<span style="background-color:${hlColor};color:${fg};padding:0 2px;border-radius:2px">${display}</span>`;
          } else if (ann.type === 'underline') {
            const ulColor = ann.color || this.plugin.settings.underlineColor || '#E8590C';
            const style = ann.underlineStyle || this.plugin.settings.underlineStyle || 'solid';
            display = `<span style="text-decoration:underline;text-decoration-color:${ulColor};text-decoration-style:${style}">${display}</span>`;
          }

          // 选中文本（引用块，自动灰色底）
          lines.push(`> [!quote] ${idx + 1}`);
          lines.push(`> ${display}`);
          lines.push('>');

          // 批注（如有）
          if (cleanComment) {
            lines.push(`> 💬 **批注：**`);
            cleanComment.split('\n').forEach(line => {
              lines.push(`> > ${line}`);
            });
            lines.push('>');
          }

          // 时间戳
          lines.push(`> — <sub>${time}</sub>`, '');
        });
      }

      // ── 页脚 ──
      lines.push('---', '');
      lines.push(`*由 **FleurAnnotation** 插件导出 · ${new Date().toLocaleDateString('zh-CN')}*`, '');

      // ── 写入文件（覆盖模式） ──
      const exportFolder = this.plugin.settings.noteFolder || 'FleurAnnotation';
      try {
        await this.app.vault.createFolder(exportFolder);
      } catch { /* 文件夹已存在则忽略 */ }

      const outPath = `${exportFolder}/批注 · ${file.basename}.md`;
      const existing = this.app.vault.getAbstractFileByPath(outPath);
      const content = lines.join('\n');

      if (existing && existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
        new Notice(`✅ 已覆盖 ${outPath}`, 5000);
      } else {
        await this.app.vault.create(outPath, content);
        new Notice(`✅ 已导出到 ${outPath}`, 5000);
      }
    } catch (err) {
      console.error('[FleurAnnotation] 导出失败:', err);
      new Notice(`❌ 导出失败：${err instanceof Error ? err.message : String(err)}`, 8000);
    }
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
