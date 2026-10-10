// 自绘选区菜单（阅读模式右键）：内联 Lucide SVG 图标 + 文字。
// 不走 Obsidian 原生 Menu——其菜单图标渲染受版本/主题影响（用户环境出现过图标整列缺失），
// 自绘后图标渲染完全可控，配色走 Obsidian CSS 变量自动适配明暗主题。
// 图标工厂 lucideIcon() 同时供选区工具条 / AI 面板 / 查词弹窗复用，保证全插件图标同一套。

export interface SelectionMenuItem {
  /** lucide 图标名（见 LUCIDE_PATHS），缺省不显示图标位 */
  icon?: string;
  label: string;
  /** 危险操作（红色调） */
  danger?: boolean;
  onClick: () => void;
}

/** 菜单项或分隔线 */
export type SelectionMenuEntry = SelectionMenuItem | 'separator';

/** lucide 图标 path 集（24×24 viewBox，stroke 风格） */
const LUCIDE_PATHS: Record<string, string> = {
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>',
  'book-open': '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  languages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  'pen-line': '<path d="M12 20h9"/><path d="M16.4 3.6a1 1 0 0 1 3 3L7.4 18.6a2 2 0 0 1-.9.5l-2.9.9a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9z"/>',
  'file-plus': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 12v6"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};

/** 生成 lucide 图标 DOM（16×16，stroke currentColor） */
export function lucideIcon(name: string, size = 16): SVGSVGElement | null {
  const paths = LUCIDE_PATHS[name];
  if (!paths) return null;
  const svgNS = 'http://www.w3.org/2000/svg';
  // 用 DOMParser 解析硬编码 path 集，避免 innerHTML（CodeQL js/unsafe-innerHTML）
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="${svgNS}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
    'image/svg+xml'
  );
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  if (!svg || svg.nodeName !== 'svg') return null;
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  return svg;
}

/** 已打开的菜单（同屏只留一个） */
let openMenuEl: HTMLElement | null = null;
let openMenuCleanup: (() => void) | null = null;

function closeOpenMenu() {
  openMenuCleanup?.();
}

/**
 * 在指定坐标弹出选区菜单；空间不足自动向上/向左翻转。
 * 点击菜单外部、Esc、或点击任一项后自动关闭。
 */
export function showSelectionMenu(x: number, y: number, entries: SelectionMenuEntry[]): void {
  closeOpenMenu();

  const menu = document.body.createDiv('fleur-selmenu');
  for (const entry of entries) {
    if (entry === 'separator') {
      menu.createDiv('fleur-selmenu-sep');
      continue;
    }
    const item = menu.createDiv('fleur-selmenu-item');
    if (entry.danger) item.addClass('is-danger');
    const iconBox = item.createSpan('fleur-selmenu-icon');
    const icon = entry.icon ? lucideIcon(entry.icon) : null;
    if (icon) iconBox.appendChild(icon);
    item.createSpan('fleur-selmenu-label').setText(entry.label);
    item.addEventListener('click', () => {
      closeOpenMenu();
      entry.onClick();
    });
  }

  // 落位：先挂载量尺寸，再定坐标（视口内翻转）
  menu.setCssStyles({ visibility: 'hidden' });
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  let left = x;
  let top = y;
  if (left + rect.width + margin > window.innerWidth) left = window.innerWidth - rect.width - margin;
  if (top + rect.height + margin > window.innerHeight) top = y - rect.height; // 向上翻转
  if (top < margin) top = margin;
  menu.setCssStyles({ left: `${Math.max(margin, left)}px`, top: `${top}px`, visibility: '' });

  const onDocMouseDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) closeOpenMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeOpenMenu();
  };
  const cleanup = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onKey, true);
    openMenuEl = null;
    openMenuCleanup = null;
  };
  openMenuEl = menu;
  openMenuCleanup = cleanup;
  setTimeout(() => {
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}
