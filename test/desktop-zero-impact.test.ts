// 桌面端零影响 · 运行时冒烟测试
// 真跑 patcher.ts / ai-chat-modal.ts 的桌面代码路径（Platform.isMobile=false），
// 并跑移动端对照组，证明 isMobile 分支真实分流、桌面路径与 1.1.10 行为一致。
import { createRequire } from 'module';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as typeof import('jsdom');

// ── jsdom 环境 ──────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
	pretendToBeVisual: true,
	url: 'http://localhost/',
});
const g = globalThis as any;
const setGlobal = (k: string, v: unknown) => {
	try {
		(g as any)[k] = v;
	} catch {
		Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
	}
};
setGlobal('window', dom.window);
setGlobal('document', dom.window.document);
setGlobal('navigator', dom.window.navigator);
setGlobal('localStorage', dom.window.localStorage);
setGlobal('HTMLElement', dom.window.HTMLElement);
setGlobal('Element', dom.window.Element);
setGlobal('Node', dom.window.Node);
setGlobal('MutationObserver', dom.window.MutationObserver);
setGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
// 阻断意外网络访问（AI 流式请求绝不许在测试中出网）
g.fetch = async () => {
	throw new Error('network blocked in test');
};

// ── Obsidian DOM 扩展 polyfill ─────────────────────────────
const proto = dom.window.Element.prototype as any;
proto.createDiv = function (cls?: string) {
	const d = this.ownerDocument.createElement('div');
	if (cls) d.className = cls;
	this.appendChild(d);
	return d;
};
proto.createSpan = function (cls?: string) {
	const s = this.ownerDocument.createElement('span');
	if (cls) s.className = cls;
	this.appendChild(s);
	return s;
};
proto.createEl = function (tag: string, cls?: string) {
	const e = this.ownerDocument.createElement(tag);
	if (cls) e.className = cls;
	this.appendChild(e);
	return e;
};
proto.setCssStyles = function (styles: Record<string, string>) {
	Object.assign(this.style, styles);
};
proto.hasClass = function (c: string) {
	return this.classList.contains(c);
};
proto.addClass = function (c: string) {
	this.classList.add(c);
};
proto.removeClass = function (c: string) {
	this.classList.remove(c);
};
proto.toggleClass = function (c: string, v: boolean) {
	this.classList.toggle(c, !!v);
};
proto.empty = function () {
	this.textContent = '';
};
proto.setText = function (t: string) {
	this.textContent = t;
	return this;
};
proto.findAll = function (sel: string) {
	return Array.from(this.querySelectorAll(sel));
};

// ── 断言工具 ───────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
function assert(cond: boolean, name: string) {
	if (cond) {
		passed++;
		console.log(`  ✅ ${name}`);
	} else {
		failures.push(name);
		console.error(`  ❌ ${name}`);
	}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 被测模块（obsidian → mock，由 esbuild alias 处理）──────
const obsidian = await import('obsidian');
const { AIChatPanel } = await import('../src/ai-chat-modal');
const { MarkdownPatcher } = await import('../src/patcher');

// mock 插件实例
function makeMockPlugin() {
	return {
		app: {
			workspace: {
				getActiveViewOfType: () => null,
				getActiveFile: () => null,
				on: () => ({}),
			},
			vault: { read: async () => '', modify: async () => {} },
		},
		settings: {
			highlightColor: '#FFD43B',
			underlineColor: 'orangered',
			wavyColor: 'purple',
			readingContextMenu: true,
		},
		registerMarkdownPostProcessor: () => {},
		generateId: () => 'test-' + Math.random().toString(36).slice(2),
		store: { addAnnotation: async () => ({}) },
	} as any;
}

console.log('\n═══ 测试 1：桌面端 AIChatPanel（Platform.isMobile=false）═══');
{
	(obsidian.Platform as any).isMobile = false;
	const plugin = makeMockPlugin();
	const panel = new AIChatPanel(plugin, '测试文本', 'explain');
	(panel as any).buildPanel(80, 60);
	const el = (panel as any).panelEl as HTMLElement;

	assert(!!el, '面板创建成功');
	assert(!el.classList.contains('fleur-ai-mobile'), '不带移动端 class（.fleur-ai-mobile）');
	assert(!el.querySelector('.fleur-ai-expand-btn'), '不创建展开/收起按钮（移动端专属）');
	assert(!!el.querySelector('.fleur-ai-resize-handle'), '缩放手柄保留（桌面功能）');
	assert(el.style.top.endsWith('px') && parseFloat(el.style.top) > 0, `内联定位生效（top=${el.style.top}，桌面锚点/记忆定位逻辑未变）`);
	assert(el.style.width === '440px', `内联宽度 440px（桌面固定尺寸未变）`);
	const header = el.querySelector('.fleur-ai-header') as any;
	assert(!!header, '标题栏存在');
	panel.close();
	assert(!document.querySelector('.fleur-ai-panel'), 'close() 清理面板');
	assert(!localStorage.getItem('fleur-annotation-ai-panel-pos'), '未发生位置写入（桌面拖拽才会写，行为未变）');
}

console.log('\n═══ 测试 2：桌面端 patcher（不注册选区工具条）═══');
{
	(obsidian.Platform as any).isMobile = false;
	const added: string[] = [];
	const orig = document.addEventListener.bind(document);
	(document as any).addEventListener = (t: string, f: any, o?: any) => {
		added.push(t);
		return orig(t, f, o);
	};
	const patcher = new MarkdownPatcher(makeMockPlugin());
	patcher.install();
	assert(!added.includes('selectionchange'), '桌面不注册 selectionchange 监听（移动端选区工具条零残留）');
	assert(added.includes('contextmenu') && added.includes('mouseup'), '桌面原有 contextmenu/mouseup 监听完整保留');
	// 桌面上 selectionchange 事件即便触发也不应产生工具条
	document.dispatchEvent(new dom.window.Event('selectionchange'));
	await sleep(450);
	assert(!document.querySelector('.fleur-mselbar'), '桌面触发 selectionchange 也不出现 .fleur-mselbar');
	patcher.uninstall();
	assert(!document.querySelector('.fleur-mselbar'), 'uninstall 干净');
}

console.log('\n═══ 测试 3：移动端对照组（证明分支真实分流）═══');
{
	(obsidian.Platform as any).isMobile = true;
	const plugin = makeMockPlugin();
	const panel = new AIChatPanel(plugin, '测试文本', 'explain');
	(panel as any).buildPanel();
	const el = (panel as any).panelEl as HTMLElement;
	assert(el.classList.contains('fleur-ai-mobile'), '移动端带 .fleur-ai-mobile class');
	assert(!!el.querySelector('.fleur-ai-expand-btn'), '移动端创建展开/收起按钮');
	assert(el.style.top === '' && el.style.left === '', '移动端无内联定位（由 CSS 两级形态接管）');
	// 展开切换
	const expandBtn = el.querySelector('.fleur-ai-expand-btn') as HTMLElement;
	expandBtn.click();
	assert(el.classList.contains('is-expanded'), '点击展开 → is-expanded');
	expandBtn.click();
	assert(!el.classList.contains('is-expanded'), '再点收起 → 两级形态切回');
	panel.close();

	// 移动端 patcher：选区稳定 → 底部工具条
	const patcher = new MarkdownPatcher(plugin);
	patcher.install();
	// 模拟笔记正文容器（真实 Obsidian 中选区锚点位于 .markdown-*-view 内）
	const note = document.createElement('div');
	note.className = 'markdown-source-view';
	note.textContent = '这是需要批注的正文内容。';
	document.body.appendChild(note);
	const range = document.createRange();
	range.selectNodeContents(note);
	dom.window.getSelection()!.removeAllRanges();
	dom.window.getSelection()!.addRange(range);
	document.dispatchEvent(new dom.window.Event('selectionchange'));
	await sleep(450);
	const bar = document.querySelector('.fleur-mselbar') as HTMLElement;
	assert(!!bar, '移动端选区稳定后出现 .fleur-mselbar');
	assert(!!bar && !bar.querySelector('[aria-label="复制"]'), '工具条无复制按钮（fleurEpub 决策①）');
	assert(!!bar && bar.querySelectorAll('.fleur-mselbar-btn').length >= 4, '工具条按钮齐全（划线/批注/AI/译）');
	patcher.uninstall();
	(obsidian.Platform as any).isMobile = false;
}

	// ── 测试 4：CSS 作用域核查 ──────────────────────────────────
console.log('\n═══ 测试 4：styles.css 移动端块作用域 ═══');
{
	const fs = await import('fs');
	const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
	const mobileIdx = css.indexOf('移动端适配');
	assert(mobileIdx > 0, '找到移动端适配 CSS 块');
	const block = css.slice(mobileIdx);
	const lines = block.split('\n');
	const offenders: string[] = [];
	let depth = 0;
	let currentSel = '';
	for (const line of lines) {
		const trimmed = line.trim();
		if (depth === 0 && trimmed && !trimmed.startsWith('/*') && !trimmed.startsWith('*') && !trimmed.startsWith('//')) {
			if (/[{,]\s*$/.test(trimmed) || trimmed.endsWith('{')) {
				currentSel = trimmed.replace(/\{.*$/, '').trim();
				// 逗号分隔的多选择器逐个检查
				for (const sel of currentSel.split(',')) {
					const s = sel.trim();
					if (!s) continue;
					const ok = s.startsWith('body.is-mobile') || s.startsWith('.fleur-ai-expand-btn');
					if (!ok) offenders.push(s);
				}
			}
		}
		depth += (line.match(/\{/g) || []).length;
		depth -= (line.match(/\}/g) || []).length;
		if (depth < 0) depth = 0;
	}
	assert(offenders.length === 0, `移动端块所有顶层选择器均限定作用域${offenders.length ? '，违规：' + offenders.join(' | ') : '（.fleur-ai-expand-btn 全局规则元素仅移动端创建，与 fleurEpub 同策略）'}`);
}

console.log(`\n═══════ 结果：${passed} 通过，${failures.length} 失败 ═══════`);
if (failures.length) {
	console.error('失败项：', failures);
	process.exit(1);
}
