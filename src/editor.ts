// Markdown 编辑器操作层 - 支持 Live Preview 和 Reading Mode
import type { Editor, TFile } from 'obsidian';

/**
 * 清理 Markdown 格式标记，返回纯文本
 */
export function stripMarkdown(text: string): string {
  if (!text) return '';
  return text
    .replace(/^(\*\*)?批[注註](\*\*)?[：:]\s*/i, '') // 去掉 "批注：" 前缀
    .replace(/#{1,6}\s+/g, '')                          // 标题
    .replace(/\*\*(.+?)\*\*/g, '$1')                    // 粗体
    .replace(/\*(.+?)\*/g, '$1')                        // 斜体
    .replace(/__(.+?)__/g, '$1')                        // 下划线
    .replace(/~~(.+?)~~/g, '$1')                        // 删除线
    .replace(/`(.+?)`/g, '$1')                          // 行内代码
    .replace(/```[\s\S]*?```/g, '')                     // 代码块
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')           // 链接
    .replace(/^>\s+/gm, '')                             // 引用
    .replace(/^[-*+]\s+/gm, '')                         // 列表
    .replace(/^\d+\.\s+/gm, '')                         // 有序列表
    .replace(/---+/g, '')                               // 分隔线
    .replace(/\s+/g, ' ')                               // 合并空白
    .trim();
}

/**
 * 转义正则特殊字符
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 清理文本：移除所有不可见字符（零宽空格、零宽连接符等），保留可见空格
 */
function cleanInvisibleChars(s: string): string {
  return s
    .replace(/\u200B/g, '')  // 零宽空格
    .replace(/\u200C/g, '')  // 零宽非连接符
    .replace(/\u200D/g, '')  // 零宽连接符
    .replace(/\uFEFF/g, '')  // 字节顺序标记
    .replace(/\u2028/g, '')  // 行分隔符
    .replace(/\u2029/g, '')  // 段落分隔符
    .replace(/\u00A0/g, ' ') // 不换行空格 -> 普通空格
    .replace(/\u0085/g, ' ') // 下一行字符 -> 普通空格
    .replace(/\r\n/g, '\n')  // Windows 换行 -> Unix 换行
    .replace(/\r/g, '\n');   // Mac 换行 -> Unix 换行
}

/**
 * 归一化文本：清理不可见字符并去除首尾空白，用于匹配
 */
function normalizeText(s: string): string {
  return cleanInvisibleChars(s).trim();
}

/**
 * 从文件内容中查找并替换文本（宽松空白匹配）
 * @param wrapFn 包裹函数，接收源文件中匹配到的原始文本（含 ** 等 Markdown 标记），返回替换后的字符串
 *              注意：Obsidian 内联语法（==、<u>、%%）不能跨段落，wrapFn 需要自行处理
 */
export function findAndReplace(
  content: string,
  searchText: string,
  wrapFn: (origMatched: string) => string
): string | null {

  // 1. 先尝试精确匹配（原始文本）
  const exactIndex = content.indexOf(searchText);
  if (exactIndex !== -1) {
    return content.substring(0, exactIndex) + wrapFn(searchText) + content.substring(exactIndex + searchText.length);
  }

  // 2. 清理不可见字符后精确匹配
  const cleanedSearch = normalizeText(searchText);
  if (cleanedSearch.length === 0) return null;

  const cleanedIndex = content.indexOf(cleanedSearch);
  if (cleanedIndex !== -1) {
    return content.substring(0, cleanedIndex) + wrapFn(cleanedSearch) + content.substring(cleanedIndex + cleanedSearch.length);
  }

  // 3. 在清理后的源文件中查找（建立精确的原始位置映射）
  const cleanedContent = normalizeText(content);
  const cleanedContentIndex = cleanedContent.indexOf(cleanedSearch);
  if (cleanedContentIndex !== -1) {
    const origToClean: Map<number, number> = new Map();
    let cleanPos = 0;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      const isClean = !/[\u200B\u200C\u200D\uFEFF\u2028\u2029]/.test(ch) && ch !== '\u00A0' && ch !== '\u0085';
      if (isClean) {
        origToClean.set(i, cleanPos);
        cleanPos++;
      } else {
        origToClean.set(i, cleanPos);
      }
    }
    origToClean.set(content.length, cleanPos);

    let origStart = -1;
    for (let i = 0; i < content.length; i++) {
      if (origToClean.get(i) === cleanedContentIndex) {
        origStart = i;
        break;
      }
    }
    if (origStart === -1) return null;

    const targetCleanEnd = cleanedContentIndex + cleanedSearch.length;
    let origEnd = -1;
    for (let i = origStart; i <= content.length; i++) {
      const cp = origToClean.get(i);
      if (cp !== undefined && cp >= targetCleanEnd) {
        origEnd = i;
        break;
      }
    }
    if (origEnd === -1) origEnd = content.length;

    const origMatched = content.substring(origStart, origEnd);
    return content.substring(0, origStart) + wrapFn(origMatched) + content.substring(origEnd);
  }

  // 4. 正则模糊匹配（允许单词间有多个空格）
  const words = cleanedSearch.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 1) {
    const pattern = words.map(w => escapeRegex(w)).join('\\s+');
    const regex = new RegExp(pattern);
    const match = content.match(regex);
    if (match) {
      return content.substring(0, match.index!) + wrapFn(match[0]) + content.substring(match.index! + match[0].length);
    }
  }

  // 5. 终极回退：忽略所有空白字符（含换行）进行匹配
  const stripAllWhitespace = (s: string) => s.replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF\u2028\u2029\u0085]+/g, '');
  const bareSearch = stripAllWhitespace(cleanedSearch);
  const bareContent = stripAllWhitespace(normalizeText(content));
  if (bareSearch.length === 0) return null;

  const bareIndex = bareContent.indexOf(bareSearch);
  if (bareIndex !== -1) {
    const bareToOrig: number[] = [];
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      const isWs = /[\s\u00A0\u200B\u200C\u200D\uFEFF\u2028\u2029\u0085]/.test(ch);
      if (!isWs) bareToOrig.push(i);
    }
    const origStart = bareToOrig[bareIndex];
    if (origStart === undefined) return null;

    const bareEndIdx = bareIndex + bareSearch.length;
    const lastOrig = bareEndIdx - 1 < bareToOrig.length
      ? bareToOrig[bareEndIdx - 1]
      : content.length - 1;
    const origEnd = lastOrig + 1;

    const origMatched = content.substring(origStart, origEnd);
    return content.substring(0, origStart) + wrapFn(origMatched) + content.substring(origEnd);
  }

  // 6. 最终回退：忽略源文件中的简单 Markdown 内联标记（**、~~、`）
  const markdownStripped = stripInlineMarkdown(content);
  if (markdownStripped) {
    const bareFromStripped = stripAllWhitespace(markdownStripped.text);
    if (bareSearch.length > 0) {
      const bareStrippedIndex = bareFromStripped.indexOf(bareSearch);
      if (bareStrippedIndex !== -1) {
        const strippedStart = markdownStripped.bareToStripped[bareStrippedIndex];
        const strippedEndIdx = bareStrippedIndex + bareSearch.length - 1;
        const strippedEnd = strippedEndIdx < markdownStripped.bareToStripped.length
          ? markdownStripped.bareToStripped[strippedEndIdx]
          : markdownStripped.text.length - 1;

        const origStart = markdownStripped.strippedToOrig[strippedStart];
        const origEnd = markdownStripped.strippedToOrig[strippedEnd] + 1;

        const origMatched = content.substring(origStart, origEnd);
        return content.substring(0, origStart) + wrapFn(origMatched) + content.substring(origEnd);
      }
    }
  }

  return null;
}

/**
 * 清理简单 Markdown 内联标记（**、*、~~、==、`），返回：
 * - text: 清理后的文本
 * - strippedToOrig: 清理后位置 -> 原位置
 * - bareToStripped: 再去空白后位置 -> 清理后位置
 */
function stripInlineMarkdown(content: string) {
  const skipIndices = new Set<number>();

  // --- 手动解析 **...** 对（正则 /\*\*[^*]+?\*\*/g 会被前面的大跨度匹配吃掉后续 ** 标记） ---
  {
    const marker = '**';
    const markerLen = marker.length; // 2
    let searchFrom = 0;
    while (true) {
      const openIdx = content.indexOf(marker, searchFrom);
      if (openIdx === -1) break;
      const closeIdx = content.indexOf(marker, openIdx + markerLen);
      if (closeIdx === -1) break;
      // 过滤跨段落的匹配
      if (!content.substring(openIdx + markerLen, closeIdx).includes('\n\n')) {
        for (let i = 0; i < markerLen; i++) {
          skipIndices.add(openIdx + i);
          skipIndices.add(closeIdx + i);
        }
      }
      searchFrom = openIdx + markerLen;
    }
  }

  // --- ~~删除线~~（用正则，因为较少跨段落问题） ---
  {
    const pattern = /~~[^~]+?~~/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[0].includes('\n\n')) continue;
      const start = match.index;
      const end = match.index + match[0].length;
      for (let i = 0; i < 2; i++) {
        skipIndices.add(start + i);
        skipIndices.add(end - 1 - i);
      }
    }
  }

  // --- `行内代码`（用正则） ---
  {
    const pattern = /`[^`]+?`/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[0].includes('\n\n')) continue;
      const start = match.index;
      const end = match.index + match[0].length;
      skipIndices.add(start);
      skipIndices.add(end - 1);
    }
  }

  let strippedText = '';
  const strippedToOrig: number[] = [];
  const wsStrippedToStripped: number[] = [];

  for (let i = 0; i < content.length; i++) {
    if (skipIndices.has(i)) continue;

    const ch = content[i];
    const isWs = /[\s\u00A0\u200B\u200C\u200D\uFEFF\u2028\u2029\u0085]/.test(ch);

    strippedText += ch;
    strippedToOrig[strippedText.length - 1] = i;

    if (!isWs) {
      wsStrippedToStripped.push(strippedText.length - 1);
    }
  }

  return {
    text: strippedText,
    strippedToOrig,
    bareToStripped: wsStrippedToStripped,
  };
}

/**
 * 从文件内容中移除包裹标记（宽松空白匹配）
 */
export function unwrapText(content: string, prefix: string, suffix: string, searchText: string): string | null {
  // 精确匹配
  const wrapped = `${prefix}${searchText}${suffix}`;
  const exactIndex = content.indexOf(wrapped);
  if (exactIndex !== -1) {
    return content.substring(0, exactIndex) + searchText + content.substring(exactIndex + wrapped.length);
  }

  // 宽松匹配
  const parts = searchText.split(/\s+/);
  if (parts.length <= 1) return null;
  const escapedPrefix = escapeRegex(prefix);
  const escapedSuffix = escapeRegex(suffix);
  const pattern = `${escapedPrefix}${parts.map(p => escapeRegex(p)).join('\\s+')}\\s*${escapedSuffix}`;
  const regex = new RegExp(pattern);
  const match = content.match(regex);
  if (!match) return null;

  return content.substring(0, match.index!) + searchText + content.substring(match.index! + match[0].length);
}

/**
 * 在编辑器中包裹选中文本（Live Preview 模式）
 */
export function wrapSelection(editor: Editor, prefix: string, suffix: string): boolean {
  const selection = editor.getSelection();
  if (!selection) return false;
  
  editor.replaceSelection(`${prefix}${selection}${suffix}`);
  return true;
}

/**
 * 在编辑器中追加文本到选中内容后面
 */
export function appendToSelection(editor: Editor, suffix: string): boolean {
  const selection = editor.getSelection();
  if (!selection) return false;
  
  editor.replaceSelection(`${selection}${suffix}`);
  return true;
}

/**
 * 从 Reading Mode 的 DOM 中获取选中文本
 */
export function getReadingModeSelection(): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  
  const text = selection.toString().trim();
  return text || null;
}

/**
 * 检查是否在 Reading Mode 中
 */
export function isInReadingMode(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  return !!el.closest?.('.markdown-preview-view, .markdown-rendered');
}

/**
 * 检查是否在 Live Preview 模式
 */
export function isInLivePreview(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  return !!el.closest?.('.markdown-source-view, .cm-editor');
}
