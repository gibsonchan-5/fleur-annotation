// 无头探针用 obsidian mock:仅覆盖 fleur-annotation 引到的最小面
export class Menu {
  addItem(_cb: (item: any) => void): Menu { return this; }
  addSeparator(): Menu { return this; }
  showAtMouseEvent(_e: MouseEvent): void {}
}
export class Notice { constructor(_msg: string, _t?: number) {} hide(): void {} }
export class MarkdownView {}
export class Modal {
  contentEl: any = { empty() {}, createEl() { return { style: {} }; } };
  open(): void {}
  close(): void {}
}
export class TFile {}
export class Plugin {}
export class Setting { constructor(_c: any) {} }
export class TextAreaComponent {}
export class TextComponent {}
export const Platform = { isMobile: false };
export function setIcon(_el: HTMLElement, _name: string): void {}
export function normalizePath(p: string): string { return p; }
export function requestUrl(_r: any): Promise<any> { return Promise.resolve({ text: '', json: {} }); }
export const MarkdownRenderer = { renderMarkdown(_md: string, _el: HTMLElement, _ctx: any, _src: any): Promise<void> { return Promise.resolve(); } };
export type App = any;
