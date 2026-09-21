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
 * 获取正文起始偏移量（跳过文件头 YAML frontmatter）
 * 剪藏类笔记的 description 常复述导语，若全文首个匹配落在 frontmatter，
 * == / <u> 等标记会被错误写入 YAML，导致正文无渲染、侧边栏却有记录
 */
export function getBodyStartOffset(content: string): number {
  const opening = /^---[ \t]*\r?\n/.exec(content);
  if (!opening) return 0;
  const rest = content.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) return 0;
  return opening[0].length + closing.index + closing[0].length;
}

/**
 * 查找第 nth 个（1-based）匹配的位置，找不到返回 -1
 */
export function findNthIndex(haystack: string, needle: string, nth = 1, from = 0): number {
  if (nth < 1) nth = 1;
  let idx = haystack.indexOf(needle, from);
  let count = 1;
  while (idx !== -1 && count < nth) {
    idx = haystack.indexOf(needle, idx + 1);
    count++;
  }
  return idx;
}

/**
 * 跨行内格式标记（**、~~）边界的选区包裹。
 * 选区起点/终点落在加粗等标记的一侧时，直接外层包裹会产生 ==…**。== 这类畸形嵌套
 * （== 跨越加粗边界，Obsidian 无法解析，原样显示）。这里把未配对的标记留在包裹之外，
 * 只包裹标记内的文本段，例如：
 *   一些…资金**。  →  ==一些…资金==**。
 * 配合外侧已有的 ** 开标记，最终渲染为加粗内高亮：**==…==**。
 */
export function wrapSegmented(origMatched: string, wrapOne: (seg: string) => string): string {
  // == / <u> 不能跨段落/行，先按行拆分
  const sep = origMatched.includes('\n\n') ? '\n\n' : origMatched.includes('\n') ? '\n' : '';
  const parts = sep ? origMatched.split(/\n\n+|\n+/) : [origMatched];
  return parts.map(p => wrapInlineBalanced(p, wrapOne)).join(sep);
}

function wrapInlineBalanced(seg: string, wrapOne: (seg: string) => string): string {
  for (const marker of ['**', '~~']) {
    const count = seg.split(marker).length - 1;
    if (count % 2 === 1) {
      // 奇数个标记：选区跨越了它的边界。判断第一个标记是收尾还是开头：
      // 标记前是正文字符（非标点/空白）→ 收尾标记（选区从标记内开始）；否则是开头标记
      const firstIdx = seg.indexOf(marker);
      const beforeCh = firstIdx > 0 ? seg[firstIdx - 1] : '';
      let inside = /[\u4e00-\u9fff\u3040-\u30ff\w]/.test(beforeCh);
      let pos = 0;
      let out = '';
      const emit = (text: string, isInside: boolean) => {
        if (!text) return;
        // 重高亮场景：该段已是完整 ==包裹==，不二次包裹
        if (isInside && text.startsWith('==') && text.endsWith('==')) { out += text; return; }
        out += isInside ? wrapOne(text) : text;
      };
      while (pos <= seg.length) {
        const next = seg.indexOf(marker, pos);
        if (next === -1) { emit(seg.slice(pos), inside); break; }
        emit(seg.slice(pos, next), inside);
        out += marker; // 标记本身留在包裹外
        pos = next + marker.length;
        inside = !inside;
      }
      return out;
    }
  }
  return wrapOne(seg);
}

/**
 * 从文件内容中查找并替换文本（宽松空白匹配）
 * @param wrapFn 包裹函数，接收源文件中匹配到的原始文本（含 ** 等 Markdown 标记），返回替换后的字符串
 *              注意：Obsidian 内联语法（==、<u>、%%）不能跨段落，wrapFn 需要自行处理
 * @param occurrence 0-based：同一文本多次出现时，包裹第几处（阅读模式下由选区在 DOM 中的位置推断）。
 *              缺省 0 = 首次出现，与旧行为一致
 */
export function findAndReplace(
  content: string,
  searchText: string,
  wrapFn: (origMatched: string) => string,
  occurrence = 0
): string | null {

  // 0. 优先在正文（跳过 YAML frontmatter）中匹配，避免标记被写入 frontmatter；
  //    正文未命中时回退到下面的全文匹配流程（保持旧行为）
  const bodyStart = getBodyStartOffset(content);
  if (bodyStart > 0) {
    const bodyResult = findAndReplace(content.slice(bodyStart), searchText, wrapFn, occurrence);
    if (bodyResult !== null) {
      return content.slice(0, bodyStart) + bodyResult;
    }
  }

  // 1. 先尝试精确匹配（原始文本）
  const exactIndex = findNthIndex(content, searchText, occurrence + 1);
  if (exactIndex !== -1) {
    return content.substring(0, exactIndex) + wrapFn(searchText) + content.substring(exactIndex + searchText.length);
  }

  // 2. 清理不可见字符后精确匹配
  const cleanedSearch = normalizeText(searchText);
  if (cleanedSearch.length === 0) return null;

  const cleanedIndex = findNthIndex(content, cleanedSearch, occurrence + 1);
  if (cleanedIndex !== -1) {
    return content.substring(0, cleanedIndex) + wrapFn(cleanedSearch) + content.substring(cleanedIndex + cleanedSearch.length);
  }

  // 3. 在清理后的源文件中查找（建立精确的原始位置映射）
  const cleanedContent = normalizeText(content);
  const cleanedContentIndex = findNthIndex(cleanedContent, cleanedSearch, occurrence + 1);
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
    const regex = new RegExp(pattern, 'g');
    let match: RegExpExecArray | null;
    let seen = 0;
    while ((match = regex.exec(content)) !== null) {
      if (seen === occurrence) {
        return content.substring(0, match.index) + wrapFn(match[0]) + content.substring(match.index + match[0].length);
      }
      seen++;
      if (match[0].length === 0) regex.lastIndex++; // 防空匹配死循环
    }
  }

  // 5. 终极回退：忽略所有空白字符（含换行）进行匹配
  const stripAllWhitespace = (s: string) => s.replace(/[\s\u00A0\u200B\u200C\u200D\uFEFF\u2028\u2029\u0085]+/g, '');
  const bareSearch = stripAllWhitespace(cleanedSearch);
  const bareContent = stripAllWhitespace(normalizeText(content));
  if (bareSearch.length === 0) return null;

  const bareIndex = findNthIndex(bareContent, bareSearch, occurrence + 1);
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
      const bareStrippedIndex = findNthIndex(bareFromStripped, bareSearch, occurrence + 1);
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
 * 推断阅读模式选区中的文本是其在预览正文中的第几处出现（0-based，首个返回 0）。
 * 原理：用 Range 计算选区起点在预览容器文本流中的偏移，统计该偏移之前（含起点处）
 * 目标文本已完整出现的次数。同一段文本多次出现时，用它把 == 包裹写到正确的那一处。
 * 探测失败一律返回 0（退回旧行为）。
 */
export function getReadingModeOccurrence(selectionText: string): number {
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return 0;
    const range = sel.getRangeAt(0);

    const startNode = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as HTMLElement
      : range.startContainer.parentElement;
    const root = startNode?.closest('.markdown-preview-view, .markdown-rendered');
    if (!root) return 0;

    // 选区起点之前，预览容器内的文本长度
    const pre = document.createRange();
    pre.selectNodeContents(root);
    pre.setEnd(range.startContainer, range.startOffset);
    const pos = pre.toString().length;

    const probe = selectionText.trim();
    if (!probe) return 0;
    const text = root.textContent || '';

    // 精确统计：pos 及之前完整出现的次数（第 N 处出现 → 返回 N-1）
    let count = 0;
    let idx = text.indexOf(probe);
    while (idx !== -1 && idx <= pos) {
      count++;
      idx = text.indexOf(probe, idx + 1);
    }
    if (count > 0) return count - 1;

    // 回退：渲染文本与选区文本可能有空白差异，归一化后计数
    // （归一化前缀 = 选区起点之前的文本，其中完整出现过的次数即所选出现的 0-based 序号）
    const norm = (s: string) => s.replace(/\s+/g, '');
    const nProbe = norm(probe);
    if (nProbe.length < 2) return 0;
    const nText = norm(text.slice(0, pos));
    let nCount = 0;
    let sIdx = nText.indexOf(nProbe);
    while (sIdx !== -1) {
      nCount++;
      sIdx = nText.indexOf(nProbe, sIdx + 1);
    }
    return nCount;
  } catch {
    return 0;
  }
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
