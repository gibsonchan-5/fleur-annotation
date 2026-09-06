import { MarkdownRenderer, Notice } from 'obsidian';
import type FleurAnnotationPlugin from './main';
import { AIService } from './ai-service';
import { resolveSystemPrompt, resolveAskHint } from './ai-prompts';

const ICON_SEND = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
const ICON_STOP = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;

export class AIChatPanel {
  private panelEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private followUpInput: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  private chatHistory: { role: string; content: string }[] = [];
  private rawMarkdown = '';
  private initialSent = false;
  private lastResponseEl: HTMLElement | null = null;
  private lastActionsEl: HTMLElement | null = null;

  private abortController: AbortController | null = null;
  private isStreaming = false;

  // 预渲染的发送/停止 SVG 图标（避免 innerHTML）
  private sendIconEl: HTMLSpanElement | null = null;
  private stopIconEl: HTMLSpanElement | null = null;

  private isDragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private isResizing = false;

  private static readonly POS_KEY = 'fleur-annotation-ai-panel-pos';

  private static getSavedPos(): { left: number; top: number } | null {
    try {
      const raw = localStorage.getItem(AIChatPanel.POS_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        // 验证坐标仍在屏幕范围内
        if (pos.left >= 0 && pos.left < window.innerWidth - 100 &&
            pos.top >= 0 && pos.top < window.innerHeight - 100) {
          return pos;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  private static savePos(left: number, top: number) {
    try {
      localStorage.setItem(AIChatPanel.POS_KEY, JSON.stringify({ left, top }));
    } catch { /* ignore */ }
  }

  constructor(
    private plugin: FleurAnnotationPlugin,
    private selectedText: string,
    private mode: 'explain' | 'translate' = 'explain'
  ) {}

  open(anchorX?: number, anchorY?: number) {
    if (this.panelEl) this.close();
    this.buildPanel(anchorX, anchorY);
    requestAnimationFrame(() => this.sendInitial());
  }

  close() {
    this.abortStream();
    if (this.clickOutsideHandler) {
      document.removeEventListener('mousedown', this.clickOutsideHandler);
      this.clickOutsideHandler = null;
    }
    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
  }

  private abortStream() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.isStreaming) {
      this.isStreaming = false;
      this.updateSendButton();
    }
  }

  private buildPanel(anchorX?: number, anchorY?: number) {
    const panelWidth = 440;
    const panelHeight = 560;
    let left: number;
    let top: number;

    // 优先级：上次保存的位置 > 鼠标位置 > 默认位置
    const saved = AIChatPanel.getSavedPos();
    if (saved) {
      left = saved.left;
      top = saved.top;
    } else if (anchorX !== undefined && anchorY !== undefined) {
      // 优先在鼠标右侧打开，空间不够则放左侧
      if (anchorX + panelWidth + 20 < window.innerWidth) {
        left = anchorX + 20;
      } else {
        left = Math.max(20, anchorX - panelWidth - 20);
      }
      // 垂直方向：优先在鼠标下方，空间不够则放上方
      if (anchorY + panelHeight + 20 < window.innerHeight) {
        top = anchorY + 20;
      } else {
        top = Math.max(20, anchorY - panelHeight - 20);
      }
    } else {
      // 默认位置：屏幕右侧，垂直居中
      left = window.innerWidth - panelWidth - 24;
      top = (window.innerHeight - panelHeight) / 2;
      top = Math.max(20, top);
    }

    this.panelEl = document.body.createDiv();
    this.panelEl.addClass('fleur-ai-panel');
    // 动态位置/尺寸通过 setCssStyles 设置
    this.panelEl.setCssStyles({
      top: `${top}px`,
      left: `${left}px`,
      right: 'auto',
      width: `${panelWidth}px`,
      height: `${panelHeight}px`
    });

    // 动画 keyframes 已移至 styles.css

    this.clickOutsideHandler = (e: MouseEvent) => {
      if (this.panelEl && !this.panelEl.contains(e.target as Node)) {
        this.close();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', this.clickOutsideHandler!), 50);

    // 标题栏
    const header = this.panelEl.createDiv();
    header.addClass('fleur-ai-header');
    header.addEventListener('mousedown', (e) => this.onDragStart(e));

    const title = header.createSpan({ text: '阅读助手' });
    title.addClass('fleur-ai-title');

    const closeBtn = header.createEl('button');
    closeBtn.textContent = '×';
    closeBtn.addClass('fleur-ai-close-btn');
    closeBtn.addEventListener('click', () => this.close());

    // 内容区
    this.bodyEl = this.panelEl.createDiv();
    this.bodyEl.addClass('fleur-ai-body');

    // 底部输入区
    const footer = this.panelEl.createDiv();
    footer.addClass('fleur-ai-footer');

    this.followUpInput = footer.createEl('textarea');
    this.followUpInput.placeholder = '继续追问…';
    this.followUpInput.addClass('fleur-ai-input');
    this.followUpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendFollowUp();
      }
    });

    this.sendBtn = footer.createEl('button');
    // 预渲染 SVG 图标（发送/停止）
    const iconWrap = this.sendBtn.createSpan();
    iconWrap.addClass('fleur-ai-send-icon');
    
    // 发送图标
    const svgSend = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgSend.setAttribute('width', '18');
    svgSend.setAttribute('height', '18');
    svgSend.setAttribute('viewBox', '0 0 24 24');
    svgSend.setAttribute('fill', 'none');
    svgSend.setAttribute('stroke', 'currentColor');
    svgSend.setAttribute('stroke-width', '2');
    svgSend.setAttribute('stroke-linecap', 'round');
    svgSend.setAttribute('stroke-linejoin', 'round');
    const lineSend = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    lineSend.setAttribute('x1', '22'); lineSend.setAttribute('y1', '2');
    lineSend.setAttribute('x2', '11'); lineSend.setAttribute('y2', '13');
    svgSend.appendChild(lineSend);
    const polySend = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polySend.setAttribute('points', '22 2 15 22 11 13 2 9 22 2');
    svgSend.appendChild(polySend);
    iconWrap.appendChild(svgSend);
    this.sendIconEl = svgSend as unknown as HTMLSpanElement;
    
    // 停止图标
    const svgStop = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgStop.setAttribute('width', '18');
    svgStop.setAttribute('height', '18');
    svgStop.setAttribute('viewBox', '0 0 24 24');
    svgStop.setAttribute('fill', 'none');
    svgStop.setAttribute('stroke', 'currentColor');
    svgStop.setAttribute('stroke-width', '2');
    svgStop.setAttribute('stroke-linecap', 'round');
    svgStop.setAttribute('stroke-linejoin', 'round');
    const rectStop = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rectStop.setAttribute('x', '6'); rectStop.setAttribute('y', '6');
    rectStop.setAttribute('width', '12'); rectStop.setAttribute('height', '12');
    rectStop.setAttribute('rx', '1');
    svgStop.appendChild(rectStop);
    svgStop.addClass('fleur-hidden');
    iconWrap.appendChild(svgStop);
    this.stopIconEl = svgStop as unknown as HTMLSpanElement;
    this.sendBtn.addClass('fleur-ai-send-btn');
    this.sendBtn.addEventListener('click', () => this.onSendOrAbort());

    // 右下角尺寸调整手柄
    const resizeHandle = this.panelEl.createDiv();
    resizeHandle.addClass('fleur-ai-resize-handle');
    resizeHandle.addEventListener('mousedown', (e) => this.onResizeStart(e));
  }

  // ── 拖拽 & 缩放 ───

  private onDragStart(e: MouseEvent) {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    this.isDragging = true;
    const rect = this.panelEl!.getBoundingClientRect();
    this.dragOffsetX = e.clientX - rect.left;
    this.dragOffsetY = e.clientY - rect.top;
    document.addEventListener('mousemove', this.onDragMove);
    document.addEventListener('mouseup', this.onDragEnd);
  }

  private onDragMove = (e: MouseEvent) => {
    if (!this.isDragging || !this.panelEl) return;
    const x = e.clientX - this.dragOffsetX;
    const y = e.clientY - this.dragOffsetY;
    this.panelEl.setCssStyles({
      left: `${x}px`,
      top: `${y}px`,
      right: 'auto'
    });
  };

  private onDragEnd = () => {
    this.isDragging = false;
    document.removeEventListener('mousemove', this.onDragMove);
    document.removeEventListener('mouseup', this.onDragEnd);
    if (this.panelEl) {
      const rect = this.panelEl.getBoundingClientRect();
      AIChatPanel.savePos(rect.left, rect.top);
    }
  };

  private onResizeStart(e: MouseEvent) {
    e.stopPropagation();
    this.isResizing = true;
    const rect = this.panelEl!.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;

    const onMove = (e: MouseEvent) => {
      if (!this.isResizing || !this.panelEl) return;
      const w = startW + (e.clientX - startX);
      const h = startH + (e.clientY - startY);
      this.panelEl.setCssStyles({
        width: `${Math.max(320, w)}px`,
        height: `${Math.max(300, h)}px`
      });
    };
    const onUp = () => {
      this.isResizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (this.panelEl) {
        const rect = this.panelEl.getBoundingClientRect();
        AIChatPanel.savePos(rect.left, rect.top);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ─── 消息渲染 ───

  private addMessage(role: 'user' | 'assistant', content: string) {
    if (!this.bodyEl) return;

    const msg = this.bodyEl.createDiv();
    msg.addClass('fleur-msg');
    msg.addClass(role === 'user' ? 'fleur-msg-user' : 'fleur-msg-assistant');

    const bubble = msg.createDiv();
    bubble.addClass('fleur-bubble');
    bubble.addClass(role === 'user' ? 'fleur-bubble-user' : 'fleur-bubble-assistant');

    if (role === 'user') {
      bubble.textContent = content;
    } else {
      // AI 消息使用 Markdown 渲染
      MarkdownRenderer.renderMarkdown(content, bubble, '', this as any);
      this.lastResponseEl = bubble;
    }

    // 操作按钮（仅 AI 消息）
    if (role === 'assistant') {
      const actions = msg.createDiv();
      actions.addClass('fleur-msg-actions');
      this.lastActionsEl = actions;

      const makeBtn = (text: string, onClick: () => void) => {
        const btn = actions.createEl('button', { text });
        btn.addClass('fleur-msg-action-btn');
        btn.addEventListener('click', onClick);
        return btn;
      };

      makeBtn('复制', () => {
        navigator.clipboard.writeText(content);
        const btn = actions.querySelector('button')!;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      });

      makeBtn('记入笔记', () => this.saveToNote(content));

      makeBtn('重新生成', () => this.regenerate());
    }

    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  private addStreamingChunk(content: string) {
    if (!this.bodyEl) return;

    if (!this.lastResponseEl) {
      const msg = this.bodyEl.createDiv();
      msg.addClass('fleur-msg');
      msg.addClass('fleur-msg-assistant');
      const bubble = msg.createDiv();
      bubble.addClass('fleur-bubble');
      bubble.addClass('fleur-bubble-assistant');
      this.lastResponseEl = bubble;

      const actions = msg.createDiv();
      actions.addClass('fleur-msg-actions');
      this.lastActionsEl = actions;

      const makeBtn = (text: string, onClick: () => void) => {
        const btn = actions.createEl('button', { text });
        btn.addClass('fleur-msg-action-btn');
        btn.addEventListener('click', onClick);
        return btn;
      };

      makeBtn('复制', () => {
        navigator.clipboard.writeText(this.rawMarkdown);
        const btn = actions.querySelector('button')!;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      });

      makeBtn('记入笔记', () => this.saveToNote(this.rawMarkdown));

      makeBtn('重新生成', () => this.regenerate());
    }

    this.rawMarkdown += content;
    // 清空后用 Markdown 重新渲染
    this.lastResponseEl.empty();
    MarkdownRenderer.renderMarkdown(this.rawMarkdown, this.lastResponseEl, '', this as any);
    this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
  }

  // ─── 发送逻辑 ───

  private async sendInitial() {
    if (this.initialSent) return;
    this.initialSent = true;

    let systemPrompt: string;
    let userMessage: string;

    if (this.mode === 'translate') {
      // 翻译模式：专用角色，保持独立，不跟随「提示词模式」设置
      systemPrompt = '你是一位专业的翻译助手。请将用户提供的文本翻译成中文，保持原文的语义和风格。如果原文已经是中文，则翻译成英文。回答时只给出翻译结果，不需要额外解释。';
      userMessage = `请翻译以下内容：\n\n「${this.selectedText}」`;
    } else {
      // 解释模式：跟随设置里选的「提示词模式」，但作为对话场景不设字数限制
      systemPrompt = resolveSystemPrompt(
        this.plugin.settings.promptPreset,
        this.plugin.settings.customPrompts
      );
      systemPrompt += '回答时使用 Markdown 格式，标题用 ## 或 ###，重点加粗。';
      const hint = resolveAskHint(this.plugin.settings.promptPreset);
      userMessage = `以下是我从文档中选中的内容：\n\n「${this.selectedText}」\n\n${hint}`;
    }

    this.chatHistory = [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: userMessage
      }
    ];

    await this.doStream();
  }

  private async sendFollowUp() {
    const input = this.followUpInput;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    this.addMessage('user', text);
    this.chatHistory.push({ role: 'user', content: text });

    await this.doStream();
  }

  private async doStream() {
    const service = new AIService(this.plugin);
    this.rawMarkdown = '';
    this.lastResponseEl = null;
    this.lastActionsEl = null;
    this.isStreaming = true;
    this.updateSendButton();

    this.abortController = new AbortController();

    try {
      let errMessage = '';
      await service.streamChat(
        this.chatHistory,
        (chunk) => this.addStreamingChunk(chunk),
        undefined,
        (error) => { errMessage = error; },
        this.abortController.signal
      );

      if (errMessage) {
        this.addMessage('assistant', `❌ ${errMessage}`);
      } else if (this.rawMarkdown) {
        this.chatHistory.push({ role: 'assistant', content: this.rawMarkdown });
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // 用户主动中断
        if (this.rawMarkdown) {
          this.chatHistory.push({ role: 'assistant', content: this.rawMarkdown });
        }
      } else {
        this.addMessage('assistant', `❌ 请求失败：${err.message}`);
      }
    } finally {
      this.isStreaming = false;
      this.abortController = null;
      this.updateSendButton();
    }
  }

  private async regenerate() {
    if (this.isStreaming) return;
    if (this.chatHistory.length < 2) return;

    // 移除最后一条 AI 回复
    this.chatHistory.pop();
    this.bodyEl!.lastElementChild?.remove(); // 移除最后一条消息 DOM

    await this.doStream();
  }

  private onSendOrAbort() {
    if (this.isStreaming) {
      this.abortStream();
    } else {
      this.sendFollowUp();
    }
  }

  private updateSendButton() {
    if (!this.sendBtn || !this.sendIconEl || !this.stopIconEl) return;
    this.sendBtn.toggleClass('is-streaming', this.isStreaming);
    this.sendIconEl.toggleClass('fleur-hidden', this.isStreaming);
    this.stopIconEl.toggleClass('fleur-hidden', !this.isStreaming);
  }

  /** 将 AI 回复保存为笔记，默认存到 FleurAnnotation 文件夹 */  private async saveToNote(content: string) {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file) {
      new Notice('请先打开一个笔记');
      return;
    }

    const folder = this.plugin.settings.noteFolder || 'FleurAnnotation';
    const baseName = file.basename;
    const fileName = `${baseName}-AI批注-${Date.now()}.md`;
    const filePath = folder ? `${folder}/${fileName}` : fileName;

    // 确保文件夹存在
    if (folder && !this.plugin.app.vault.getAbstractFileByPath(folder)) {
      await this.plugin.app.vault.createFolder(folder);
    }

    // 构建笔记内容
    const title = `${this.mode === 'translate' ? '翻译' : '解释'}：${baseName}`;
    const noteContent = `# ${title}\n\n**原文：**\n\n> ${this.selectedText}\n\n**AI 回复：**\n\n${content}\n\n---\n_由 FleurAnnotation 自动生成于 ${new Date().toLocaleString('zh-CN')}_\n`;

    await this.plugin.app.vault.create(filePath, noteContent);
    new Notice(`已保存到 ${filePath}`);
  }
}
