// 多端同步行为测试：合并写 / 墓碑防复活 / 损坏保护 / 路径镜像 / 双端并发模拟
import { createRequire } from 'module';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as typeof import('jsdom');

// ── jsdom 环境（store 只用到 document 一角，但 obsidian normalizePath 不依赖 DOM）──
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as any;
for (const k of ['document', 'HTMLElement', 'Element', 'Node', 'MutationObserver'] as const) {
	try {
		g[k] = (dom.window as any)[k];
	} catch {
		Object.defineProperty(g, k, { value: (dom.window as any)[k], configurable: true });
	}
}

// ── 内存文件系统 mock adapter ───────────────────────────────
class MemAdapter {
	files = new Map<string, string>();
	async read(p: string) {
		if (!this.files.has(p)) throw new Error(`ENOENT: no such file, read '${p}'`);
		return this.files.get(p)!;
	}
	async write(p: string, data: string) {
		this.files.set(p, data);
	}
	async exists(p: string) {
		return this.files.has(p) || [...this.files.keys()].some((k) => k.startsWith(p + '/'));
	}
	async mkdir(p: string) {
		this.files.set(p + '/', '');
	}
	async remove(p: string) {
		this.files.delete(p);
	}
	async list(p: string) {
		const norm = (s: string) => s.replace(/\/+$/, '');
		const all = [...this.files.keys()].map(norm);
		const direct = new Set<string>();
		for (const k of all) {
			if (!k.startsWith(p + '/')) continue;
			const rest = k.slice(p.length + 1);
			direct.add(rest.includes('/') ? p + '/' + rest.split('/')[0] : k);
		}
		const files = [...direct].filter((x) => !this.files.has(x + '/') || x.includes('.'));
		const folders = [...direct].filter((x) => this.files.has(x + '/') && !x.includes('.json'));
		return { files, folders };
	}
}

function makeApp(adapter: MemAdapter) {
	return { vault: { configDir: '.obsidian', adapter } } as any;
}

const SYNC_ON = () => ({ syncAnnotationsToVault: true, annotationsDataDir: 'FleurAnnotation 数据' });
const SYNC_OFF = () => ({ syncAnnotationsToVault: false });

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

const { AnnotationStore, mergeAnnotations } = await import('../src/store');

const NOTE = '工作/工作资料/文明办三项行动/“门前三包”总体工作情况.md';
const mkAnn = (id: string, over: Partial<any> = {}) => ({
	id,
	type: 'highlight' as const,
	text: '文本' + id,
	createdAt: 1700000000000 + Number(id),
	...over,
});

console.log('\n═══ 1. mergeAnnotations 纯函数 ═══');
{
	const a1 = mkAnn('1', { updatedAt: 100 });
	const a1n = mkAnn('1', { comment: '改过', updatedAt: 200 });
	const a2 = mkAnn('2');
	// 并集
	let m = mergeAnnotations([a1], [a2]);
	assert(m.length === 2 && m.some((x) => x.id === '1') && m.some((x) => x.id === '2'), '两端各自新增取并集');
	// LWW
	m = mergeAnnotations([a1], [a1n]);
	assert(m.length === 1 && m[0].comment === '改过', '同 id 按 updatedAt 取新');
	// 同毫秒删除优先（墓碑时间戳须取「现在」，遥远过去会被当过期墓碑回收——那是正确行为）
	const now = Date.now();
	const aNow = mkAnn('1', { updatedAt: now });
	const delNow = mkAnn('1', { updatedAt: now, deletedAt: now });
	m = mergeAnnotations([aNow], [delNow]);
	assert(m.length === 1 && m[0].deletedAt, '同毫秒冲突删除优先');
	// 收敛性：参数顺序无关
	const x = mkAnn('x', { comment: 'a', updatedAt: 5 });
	const y = mkAnn('x', { comment: 'b', updatedAt: 5 });
	assert(
		JSON.stringify(mergeAnnotations([x], [y])) === JSON.stringify(mergeAnnotations([y], [x])),
		'同毫秒同态按确定性序列化收敛（顺序无关）',
	);
	// 墓碑 TTL 内保留、过期回收
	const oldTomb = mkAnn('old', { deletedAt: Date.now() - 31 * 24 * 3600 * 1000, updatedAt: 1 });
	m = mergeAnnotations([], [oldTomb]);
	assert(m.length === 0, '过期墓碑回收');
}

console.log('\n═══ 2. 双端并发模拟（合并写）═══');
{
	const adapter = new MemAdapter();
	const app = makeApp(adapter);
	// 两端 = 两个独立 store 实例（各自的 lastWritten 内存互不相通）
	const desktop = new AnnotationStore(app, 'fleur-annotation', SYNC_ON);
	const mobile = new AnnotationStore(app, 'fleur-annotation', SYNC_ON);

	// 桌面加批注 A
	await desktop.addAnnotation(NOTE, mkAnn('A'));
	// 手机 load（拿到 A）→ 又加了批注 B
	await mobile.addAnnotation(NOTE, mkAnn('B'));
	const onMobile = await mobile.load(NOTE);
	assert(onMobile.annotations.length === 2, '移动端看到两端批注（文件层面已同步）');

	// 真实丢数据路径时序：桌面先 load（内存变陈旧）→ 手机写盘 → 桌面本地加批注后保存
	const desktop2 = new AnnotationStore(app, 'fleur-annotation', SYNC_ON);
	const staleView = await desktop2.load(NOTE); // 此刻磁盘 = A、B
	await mobile.addAnnotation(NOTE, mkAnn('C')); // 外部（手机）写入
	staleView.annotations.push(mkAnn('D')); // 桌面本地加 D（内存里没有 C）
	await desktop2.save(staleView); // lastWritten 已过期 → 合并写介入
	const final = await mobile.load(NOTE);
	const ids = final.annotations.map((a) => a.id).sort();
	assert(JSON.stringify(ids) === JSON.stringify(['A', 'B', 'C', 'D']), `合并写吸收外部批注（A/B/C/D 全保留，实际 ${ids}）`);
}

console.log('\n═══ 3. 删除墓碑（防复活）═══');
{
	const adapter = new MemAdapter();
	const app = makeApp(adapter);
	const desktop = new AnnotationStore(app, 'fleur-annotation', SYNC_ON);
	const mobile = new AnnotationStore(app, 'fleur-annotation', SYNC_ON);

	await desktop.addAnnotation(NOTE, mkAnn('A'));
	await desktop.addAnnotation(NOTE, mkAnn('B'));
	// 手机 load 过（内存有 A、B）
	await mobile.load(NOTE);
	// 桌面删除 A（打墓碑）
	await desktop.deleteAnnotation(NOTE, 'A');
	const onDesktop = await desktop.load(NOTE);
	assert(onDesktop.annotations.length === 1 && onDesktop.annotations[0].id === 'B', '删除后视图不再显示（墓碑过滤）');
	assert(adapter.files.get(`${'FleurAnnotation 数据'}/${NOTE}.json`)?.includes('"deletedAt"'), '磁盘保留墓碑');

	// 手机内存还是旧的（含 A），保存一次 → 墓碑必须活下来
	const staleMobile = new AnnotationStore(app, 'fleur-annotation', SYNC_ON);
	const view = await staleMobile.load(NOTE); // 此时磁盘已无 A（活条目）
	view.annotations.push(mkAnn('C')); // 手机又加了 C
	await staleMobile.save(view);
	const check = await desktop.load(NOTE);
	const ids = check.annotations.map((a) => a.id).sort();
	assert(
		JSON.stringify(ids) === JSON.stringify(['B', 'C']),
		`墓碑不被另一端旧内存复活（实际 ${ids}）`,
	);
	// 直接验证磁盘上墓碑仍在
	assert(adapter.files.get(`${'FleurAnnotation 数据'}/${NOTE}.json`)?.includes('"deletedAt"'), '墓碑仍在磁盘（30 天 TTL 内）');
}

console.log('\n═══ 4. 损坏保护 ═══');
{
	const adapter = new MemAdapter();
	const app = makeApp(adapter);
	const store = new AnnotationStore(app, 'fleur-annotation', SYNC_ON);
	await store.addAnnotation(NOTE, mkAnn('A'));
	// 外部把文件写坏
	const path = `${'FleurAnnotation 数据'}/${NOTE}.json`;
	await adapter.write(path, '{ corrupt json!!');
	// 本地保存 → 必须放弃写入并留备份
	const view = await store.load(NOTE); // load 读坏文件 → 空数据
	await store.save({ fileId: NOTE, annotations: [mkAnn('B')] });
	const files = [...adapter.files.keys()].filter((k) => k.includes('corrupt'));
	assert(files.length === 1, `损坏内容已另存备份（${files[0] ?? '无'}）`);
	assert(adapter.files.get(path) === '{ corrupt json!!', '磁盘原文件一个字节未动');
	// 同一份损坏内容第二次 → 允许覆盖自愈
	await store.save({ fileId: NOTE, annotations: [mkAnn('B')] });
	assert(adapter.files.get(path)?.includes('"annotations"'), '第二次起允许覆盖（自愈）');
}

console.log('\n═══ 5. Vault 模式路径镜像 ═══');
{
	const adapter = new MemAdapter();
	const store = new AnnotationStore(makeApp(adapter), 'fleur-annotation', SYNC_ON);
	await store.addAnnotation(NOTE, mkAnn('A'));
	const expected = 'FleurAnnotation 数据/工作/工作资料/文明办三项行动/“门前三包”总体工作情况.md.json';
	assert(adapter.files.has(expected), '中英文路径按目录树镜像，不再压成下划线');
	// 配置目录模式保持旧 hash 文件名（独立 adapter 验证，不与同步目录混淆）
	const legacyAdapter = new MemAdapter();
	const legacy = new AnnotationStore(makeApp(legacyAdapter), 'fleur-annotation', SYNC_OFF);
	await legacy.addAnnotation(NOTE, mkAnn('A'));
	const legacyFiles = [...legacyAdapter.files.keys()].filter((k) => !k.endsWith('/'));
	assert(
		legacyFiles.length === 1 && legacyFiles[0].startsWith('.obsidian/plugins/fleur-annotation/data/'),
		`SYNC_OFF 实例写入配置目录而非同步目录（${legacyFiles.join(', ')}）`,
	);
}

console.log('\n═══ 6. 开关关闭 = 原行为 ═══');
{
	const adapter = new MemAdapter();
	const app = makeApp(adapter);
	const store = new AnnotationStore(app, 'fleur-annotation', SYNC_OFF);
	await store.addAnnotation(NOTE, mkAnn('A'));
	const expected = '.obsidian/plugins/fleur-annotation/data/' + NOTE.replace(/[^a-zA-Z0-9]/g, '_') + '.json';
	assert(adapter.files.has(expected), '关闭开关时走旧 hash 路径（零影响）');
	const got = await store.load(NOTE);
	assert(got.annotations.length === 1, '读写正常');
}

console.log(`\n═══════ 结果：${passed} 通过，${failures.length} 失败 ═══════`);
if (failures.length) {
	console.error('失败项：', failures);
	process.exit(1);
}
