// 测试专用 obsidian 模块替身（esbuild alias:obsidian → 本文件）
// 仅覆盖被测文件（patcher.ts / ai-chat-modal.ts / editor.ts）用到的值导入。

export class Platform {
	static isMobile = false;
	static isIosApp = false;
	static isAndroidApp = false;
	static isTablet = false;
	static resourcePath = '/tmp/';
}

export class Notice {
	constructor(public message?: string, public timeout?: number) {}
	hide() {}
}

export class Menu {
	addItem(_cb: (item: any) => any): Menu {
		_cb({
			setTitle: () => ({}),
			setIcon: () => ({}),
			onClick: () => ({}),
		});
		return this;
	}
	addSeparator(): Menu {
		return this;
	}
}

export class Modal {
	app: any;
	contentEl: any;
	modalEl: any;
	constructor(app?: any) {
		this.app = app;
	}
	open() {}
	close() {}
}

export class MarkdownView {}
export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export class ItemView {}
export class WorkspaceLeaf {}
export class Component {}
export class Plugin {}

export class MarkdownRenderer {
	static render(): Promise<void> {
		return Promise.resolve();
	}
}

export function setIcon(_el: any, _icon: string) {}
export function normalizePath(p: string): string {
	return p;
}
