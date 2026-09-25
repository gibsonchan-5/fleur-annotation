// 数据存储层
//
// ── 多端同步安全（对齐 fleurEpub store 第二期）──────────────────────────
// 批注数据可按设置写入 Vault 内普通目录，随 iCloud / Obsidian Sync / Remotely Save
// 等同步器跨设备流转。同步带来一条丢数据路径（不需要两端同时编辑）：
//   手机加批注 → 同步器把新文件拉到桌面 → 桌面内存里是旧数组 → 保存时整份覆盖
//   → 下次同步把「没有这条」的版本推回手机 → 两端一起丢。
// 堵法三件套（对齐 fleurEpub 同类机制，实现按本插件特点简化）：
//   1. 合并写：保存永远「读磁盘全量 → 按 id/updatedAt 取并集 → 写回」。内存持有的是
//      活条目视图（load 过滤墓碑），磁盘全量是合并基准，墓碑永不因本机保存而丢失。
//      （fleurEpub 另有 lastWritten 短路优化，那是为分域大文件+800ms 高频进度写设计的；
//      本插件 sidecar 为 KB 级低频写，直接合并更简单且无墓碑覆盖缝隙。）
//   2. 墓碑：删除打 deletedAt 而非移除，否则另一端那条存活副本会在并集合并时复活。
//      墓碑按 30 天 TTL 回收，且只在合并路径清理。
//   3. 损坏不覆盖：磁盘 JSON 解析失败时先另存备份，本次不写；同一份损坏第二次起允许覆盖自愈。
// 开关关闭（默认）时数据仍存配置目录、文件名保持旧哈希，单设备用户零影响。
import { App, TFile, normalizePath } from 'obsidian';
import type { Annotation, MarkdownAnnotationData, AIResult } from './types';

/** 墓碑保留时长：必须长于「另一端可能离线的最久时间」，否则存活副本复活 */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 损坏备份文件名：`<原名>.corrupt-<时间戳>` */
const CORRUPT_BACKUP_RE = /\.corrupt-\d+\.json$/;

function isMissingFileError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return /ENOENT|no such file|not exist|404/i.test(msg);
}

/** 确定性序列化：键排序后输出，用于「内容相同却判为不同」的假差异消除 */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
	const o = value as Record<string, unknown>;
	return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

/** 合并用时间线：优先 updatedAt，老数据回落 createdAt */
function itemTime(a: { updatedAt?: number; createdAt: number }): number {
	const t = a.updatedAt ?? a.createdAt;
	return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}

/**
 * 合并批注（同步核心纯函数，对齐 fleurEpub mergeAnnotations）：
 *   · 以 id 对齐取并集——两端各自新增的都保留；
 *   · 同 id 冲突按 updatedAt 取新；
 *   · 同毫秒冲突删除优先（宁可少一条也不让删掉的批注复活）；
 *   · 同毫秒且删除态相同按确定性序列化取大者——保证两端算出完全一致的结果，
 *     否则每次同步都互相判为「被改过」而反复写盘；
 *   · 输出按 (createdAt, id) 排序，同样为了两端收敛。
 */
export function mergeAnnotations(
	local: readonly Annotation[] | null | undefined,
	remote: readonly Annotation[] | null | undefined,
	now: number = Date.now(),
): Annotation[] {
	const byId = new Map<string, Annotation>();
	const put = (a: Annotation) => {
		const prev = byId.get(a.id);
		if (!prev) {
			byId.set(a.id, { ...a });
			return;
		}
		const ta = itemTime(a);
		const tp = itemTime(prev);
		if (ta > tp) {
			byId.set(a.id, { ...a });
			return;
		}
		if (ta < tp) return;
		const da = typeof a.deletedAt === 'number' && a.deletedAt > 0;
		const dp = typeof prev.deletedAt === 'number' && prev.deletedAt > 0;
		if (da !== dp) {
			byId.set(a.id, da ? { ...a } : { ...prev });
			return;
		}
		if (canonicalJson(a) > canonicalJson(prev)) byId.set(a.id, { ...a });
	};
	// 顺序无关：所有分支由时间戳/内容决定
	for (const a of remote ?? []) put(a);
	for (const a of local ?? []) put(a);

	// 墓碑回收只在合并路径（重写文件本来就要发生）；load 时回收会提前抹掉墓碑导致复活
	const out = [...byId.values()].filter(
		a => !(typeof a.deletedAt === 'number' && a.deletedAt > 0) || now - (a.deletedAt as number) <= TOMBSTONE_TTL_MS,
	);
	out.sort((a, b) => {
		const d = (a.createdAt ?? 0) - (b.createdAt ?? 0);
		if (d) return d;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	return out;
}

/** AI 结果合并：无 updatedAt，按 id 取并集 + 墓碑过滤（结果不可变，无 LWW 需求） */
function mergeAIResults(
	local: readonly AIResult[] | null | undefined,
	remote: readonly AIResult[] | null | undefined,
	now: number = Date.now(),
): AIResult[] {
	const byId = new Map<string, AIResult>();
	for (const r of remote ?? []) byId.set(r.id, { ...r });
	for (const r of local ?? []) byId.set(r.id, { ...r });
	return [...byId.values()].filter(
		r => !(typeof r.deletedAt === 'number' && r.deletedAt > 0) || now - (r.deletedAt as number) <= TOMBSTONE_TTL_MS,
	);
}

export class AnnotationStore {
	private app: App;
	/** 同步相关设置（由 plugin 注入，避免循环依赖） */
	private syncSettings: () => { syncAnnotationsToVault?: boolean; annotationsDataDir?: string };
	/** 已备份过的损坏内容（按路径），同一份只备份一次 */
	private corruptSeen = new Map<string, string>();
	/** 同路径写串行化：read-modify-write 必须原子 */
	private queues = new Map<string, Promise<unknown>>();

	constructor(
		app: App,
		private pluginId: string,
		syncSettings: () => { syncAnnotationsToVault?: boolean; annotationsDataDir?: string },
	) {
		this.app = app;
		this.syncSettings = syncSettings;
	}

	/** 数据目录：默认配置目录（原行为，零影响）；设置开启「跨设备同步批注数据」后
	 *  写入 Vault 内普通目录——那是所有同步器（iCloud / Obsidian Sync / Remotely Save）
	 *  都透明覆盖的范围；.obsidian 里的插件自建子目录则不被主流同步器保证。 */
	private dataDir(): string {
		const s = this.syncSettings();
		if (s?.syncAnnotationsToVault && s.annotationsDataDir?.trim()) {
			return normalizePath(s.annotationsDataDir.trim());
		}
		return `${this.app.vault.configDir}/plugins/${this.pluginId}/data`;
	}

	/** 是否处于 Vault 同步模式（决定文件名形态：真实路径镜像 vs 哈希） */
	private isVaultMode(): boolean {
		return !!this.syncSettings()?.syncAnnotationsToVault;
	}

	/**
	 * sidecar 文件路径。
	 * · Vault 同步模式：按笔记路径镜像目录树（`<dataDir>/工作/笔记.md.json`）——
	 *   中文名不再压成下划线，hash 碰撞隐患连根消失，目录结构人类可读。
	 * · 配置目录模式：保持旧哈希文件名，存量数据完全兼容。
	 */
	private getFilePath(mdPath: string): string {
		if (this.isVaultMode()) {
			return normalizePath(`${this.dataDir()}/${mdPath}.json`);
		}
		return normalizePath(`${this.dataDir()}/${this.hashPath(mdPath)}.json`);
	}

	private hashPath(path: string): string {
		return path.replace(/[^a-zA-Z0-9]/g, '_');
	}

	/** 逐级建目录（vault 模式下 sidecar 是目录树，adapter.mkdir 不递归） */
	private async ensureDirFor(filePath: string): Promise<void> {
		const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : filePath;
		const parts = dir.split('/');
		let cur = parts[0];
		for (let i = 1; i < parts.length; i++) {
			cur = `${cur}/${parts[i]}`;
			try {
				if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.adapter.mkdir(cur);
			} catch {
				/* 已存在等竞态，忽略 */
			}
		}
	}

	async ensureDir(): Promise<void> {
		await this.ensureDirFor(`${this.dataDir()}/x`);
	}

	/** 读原文，区分「不存在」（常态）与「真出错」（留痕） */
	private async readRawText(path: string): Promise<{ ok: true; raw: string } | { ok: false; raw: '' }> {
		try {
			const raw = await this.app.vault.adapter.read(path);
			return { ok: true, raw: raw ?? '' };
		} catch (e) {
			if (!isMissingFileError(e)) console.warn('FleurAnnotation: 读取批注数据失败', path, e);
			return { ok: false, raw: '' };
		}
	}

	private parseOrNull<T>(raw: string): T | null {
		if (!raw) return null;
		try {
			const v: unknown = JSON.parse(raw);
			return v && typeof v === 'object' ? (v as unknown as T) : null;
		} catch {
			return null;
		}
	}

	private queued<T>(path: string, task: () => Promise<T>): Promise<T> {
		const prev = this.queues.get(path) ?? Promise.resolve();
		const next = prev.then(task);
		this.queues.set(
			path,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	private async writeNow(path: string, payload: string): Promise<boolean> {
		try {
			await this.ensureDirFor(path);
			await this.app.vault.adapter.write(path, payload);
			return true;
		} catch (e) {
			console.warn('FleurAnnotation: 保存批注数据失败', path, e);
			return false;
		}
	}

	async load(mdPath: string): Promise<MarkdownAnnotationData> {
		const filePath = this.getFilePath(mdPath);
		const res = await this.readRawText(filePath);
		if (!res.ok || !res.raw.trim()) {
			return { fileId: mdPath, annotations: [] };
		}
		const data = this.parseOrNull<MarkdownAnnotationData>(res.raw);
		if (!data) {
			// 损坏内容返回空数据；save 的合并路径会检测到并走备份保护
			return { fileId: mdPath, annotations: [] };
		}
		data.annotations ??= [];
		data.aiResults ??= [];
		data.fileId = mdPath;
		// 返回活条目视图：墓碑留在磁盘（合并时保全量），渲染/编辑只见活的
		return {
			fileId: mdPath,
			annotations: data.annotations.filter(a => !(typeof a.deletedAt === 'number' && a.deletedAt > 0)),
			aiResults: data.aiResults.filter(r => !(typeof r.deletedAt === 'number' && r.deletedAt > 0)),
		};
	}

	async save(data: MarkdownAnnotationData): Promise<void> {
		const filePath = this.getFilePath(data.fileId);
		await this.queued(filePath, async () => {
			// 保存永远走「读磁盘全量 → 合并 → 写回」，不设「没人动过就短路」：
			// load 返回的是活条目视图（墓碑已滤），短路直写会把另一端的墓碑覆盖丢失。
			// sidecar 为 KB 级低频写，读盘代价可忽略（fleurEpub 需要短路是因分域大文件+高频进度写）。
			// 合并幂等收敛：磁盘即本机上次写入时，merge 结果与内存内容等价，写回字节不变。
			const res = await this.readRawText(filePath);
			if (res.ok && res.raw.trim()) {
				const disk = this.parseOrNull<MarkdownAnnotationData>(res.raw);
				if (!disk) {
					// 损坏保护：备份一次，本次不覆盖；同一份损坏第二次起允许覆盖自愈
					if (this.corruptSeen.get(filePath) !== res.raw) {
						const backup = normalizePath(
							`${this.dataDir()}/${filePath.slice(filePath.lastIndexOf('/') + 1, filePath.length - 5)}.corrupt-${Date.now()}.json`,
						);
						try {
							await this.ensureDirFor(backup);
							await this.app.vault.adapter.write(backup, res.raw);
							this.corruptSeen.set(filePath, res.raw);
						} catch (e) {
							// 备份失败就绝不能覆盖
							console.warn('FleurAnnotation: 备份损坏数据失败，本次放弃写入', backup, e);
							return;
						}
						console.warn('FleurAnnotation: 批注数据文件损坏，本次未覆盖，已另存备份', filePath, '→', backup);
						return;
					}
				} else {
					data.annotations = mergeAnnotations(data.annotations, disk.annotations);
					data.aiResults = mergeAIResults(data.aiResults, disk.aiResults);
				}
			}
			await this.writeNow(filePath, JSON.stringify(data, null, 2));
		});
	}

	async addAnnotation(mdPath: string, annotation: Annotation): Promise<void> {
		annotation.updatedAt = annotation.createdAt;
		const data = await this.load(mdPath);
		data.annotations.push(annotation);
		await this.save(data);
	}

	async getAnnotations(mdPath: string): Promise<Annotation[]> {
		const data = await this.load(mdPath);
		return data.annotations;
	}

	/** 删除 = 打墓碑。必须读磁盘全量（load 的活条目视图里没有已删条目）。
	 *  另一端若还开着旧内存，它的下次保存会因合并取并集保留这条墓碑 → 不会复活。 */
	async deleteAnnotation(mdPath: string, annotationId: string): Promise<void> {
		await this.removeById(mdPath, annotationId, true);
	}

	// 兼容旧调用名
	async removeAnnotation(mdPath: string, annotationId: string): Promise<void> {
		await this.removeById(mdPath, annotationId, true);
	}

	async updateAnnotation(mdPath: string, annotation: Annotation): Promise<void> {
		annotation.updatedAt = Date.now();
		const data = await this.load(mdPath);
		const index = data.annotations.findIndex(a => a.id === annotation.id);
		if (index !== -1) {
			data.annotations[index] = annotation;
			await this.save(data);
		}
	}

	async addAIResult(mdPath: string, result: AIResult): Promise<void> {
		const data = await this.load(mdPath);
		if (!data.aiResults) {
			data.aiResults = [];
		}
		data.aiResults.push(result);
		await this.save(data);
	}

	async getAIResults(mdPath: string): Promise<AIResult[]> {
		const data = await this.load(mdPath);
		return data.aiResults || [];
	}

	async removeAIResult(mdPath: string, resultId: string): Promise<void> {
		await this.removeById(mdPath, resultId, false);
	}

	/** 删除的统一实现：读磁盘全量 → 打墓碑 → 写回（损坏则备份并放弃） */
	private async removeById(mdPath: string, id: string, isAnnotation: boolean): Promise<void> {
		const filePath = this.getFilePath(mdPath);
		await this.queued(filePath, async () => {
			const res = await this.readRawText(filePath);
			let data: MarkdownAnnotationData = { fileId: mdPath, annotations: [], aiResults: [] };
			if (res.ok && res.raw.trim()) {
				const parsed = this.parseOrNull<MarkdownAnnotationData>(res.raw);
				if (parsed) {
					data = parsed;
					data.annotations ??= [];
				} else {
					// 损坏：删除操作不覆盖（对齐损坏保护），只留日志
					console.warn('FleurAnnotation: 批注文件损坏，删除操作放弃', filePath);
					return;
				}
			}
			const now = Date.now();
			if (isAnnotation) {
				const a = data.annotations.find(x => x.id === id);
				if (a) {
					a.deletedAt = now;
					a.updatedAt = now;
				}
			} else {
				const r = (data.aiResults ??= []).find(x => x.id === id);
				if (r) r.deletedAt = now;
			}
			await this.writeNow(filePath, JSON.stringify(data, null, 2));
		});
	}

	/**
	 * 文件被移动/重命名时，把批注数据迁移到新路径。
	 * 若新路径已有批注（如删除后重新转换生成），按 id 去重合并，不覆盖新批注。
	 *
	 * @returns 实际迁移的条目数（批注 + AI 结果），0 表示无可迁移数据
	 */
	async migratePath(oldPath: string, newPath: string): Promise<number> {
		if (oldPath === newPath) return 0;
		const oldFile = this.getFilePath(oldPath);
		try {
			if (!(await this.app.vault.adapter.exists(oldFile))) return 0;
			const oldData = JSON.parse(await this.app.vault.adapter.read(oldFile)) as MarkdownAnnotationData;
			const annotations = oldData.annotations ?? [];
			const aiResults = oldData.aiResults ?? [];
			if (annotations.length === 0 && (aiResults ?? []).length === 0) {
				// 空数据无需迁移，顺手清掉空壳
				await this.app.vault.adapter.remove(oldFile);
				return 0;
			}

			// 新路径已有数据时按 id 去重合并（保留在新位置新做的批注）
			const newFile = this.getFilePath(newPath);
			let target: MarkdownAnnotationData = { fileId: newPath, annotations: [], aiResults: [] };
			if (oldFile !== newFile && (await this.app.vault.adapter.exists(newFile))) {
				try {
					const parsed = JSON.parse(await this.app.vault.adapter.read(newFile)) as MarkdownAnnotationData;
					target = {
						fileId: newPath,
						annotations: parsed.annotations ?? [],
						aiResults: parsed.aiResults ?? [],
					};
				} catch (e) {
					console.error('FleurAnnotation: 解析目标批注文件失败，将覆盖', e);
				}
			}

			const annIds = new Set(target.annotations.map(a => a.id));
			let moved = 0;
			for (const a of annotations) {
				if (!annIds.has(a.id)) {
					target.annotations.push(a);
					annIds.add(a.id);
					moved++;
				}
			}
			const resultIds = new Set((target.aiResults ?? []).map(r => r.id));
			for (const r of aiResults) {
				if (!resultIds.has(r.id)) {
					(target.aiResults ??= []).push(r);
					resultIds.add(r.id);
					moved++;
				}
			}

			if (moved > 0) await this.save(target);
			if (oldFile !== newFile) await this.app.vault.adapter.remove(oldFile);
			return moved;
		} catch (e) {
			console.error('FleurAnnotation: 批注迁移失败', oldPath, '->', newPath, e);
			return 0;
		}
	}

	/** 递归列出目录下全部文件（vault 模式 sidecar 是目录树，adapter.list 只列一层） */
	private async walkDir(dir: string): Promise<string[]> {
		const out: string[] = [];
		let listing;
		try {
			listing = await this.app.vault.adapter.list(dir);
		} catch {
			return out;
		}
		for (const f of listing.files ?? []) out.push(f);
		for (const d of listing.folders ?? []) out.push(...(await this.walkDir(d)));
		return out;
	}

	/**
	 * 文件夹被重命名/移动时，批量迁移其下所有文件的批注。
	 *
	 * @returns 迁移的批注文件数
	 */
	async migrateFolder(oldPath: string, newPath: string): Promise<number> {
		const prefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
		let migrated = 0;
		try {
			let files: string[];
			if (this.isVaultMode()) {
				// vault 模式：sidecar 目录树镜像笔记目录，递归找 oldPath 子树下的 .json
				const sidecarRoot = normalizePath(`${this.dataDir()}/${oldPath}`);
				const all = await this.walkDir(sidecarRoot);
				files = all.filter(f => f.endsWith('.json') && !CORRUPT_BACKUP_RE.test(f));
			} else {
				files = (await this.app.vault.adapter.list(this.baseDir())).files.filter(f => f.endsWith('.json'));
			}
			for (const f of files) {
				try {
					const data = JSON.parse(await this.app.vault.adapter.read(f)) as MarkdownAnnotationData;
					if (!data?.fileId || !data.fileId.startsWith(prefix)) continue;
					const n = await this.migratePath(data.fileId, newPath + data.fileId.slice(oldPath.length));
					if (n > 0) migrated++;
				} catch (e) {
					console.error('FleurAnnotation: 文件夹批注迁移失败', f, e);
				}
			}
		} catch (e) {
			console.error('FleurAnnotation: 读取批注目录失败', e);
		}
		return migrated;
	}

	/** 旧版配置目录 baseDir（迁移逻辑用） */
	baseDir(): string {
		return `${this.app.vault.configDir}/plugins/${this.pluginId}/data`;
	}

	/** 读旧配置目录里的存量 sidecar（hash 文件名，含墓碑全量；迁移用） */
	async legacyData(fileId: string): Promise<MarkdownAnnotationData | null> {
		const f = normalizePath(`${this.baseDir()}/${this.hashPath(fileId)}.json`);
		try {
			if (!(await this.app.vault.adapter.exists(f))) return null;
			return this.parseOrNull<MarkdownAnnotationData>(await this.app.vault.adapter.read(f));
		} catch {
			return null;
		}
	}

	/** 删除笔记时清理其 sidecar（同步目录与旧配置目录都尝试） */
	async deleteSidecar(mdPath: string): Promise<void> {
		const candidates = [this.getFilePath(mdPath)];
		if (!this.isVaultMode()) return;
		// 同步模式开启时也清理旧配置目录里的残留
		candidates.push(normalizePath(`${this.baseDir()}/${this.hashPath(mdPath)}.json`));
		for (const f of candidates) {
			try {
				if (await this.app.vault.adapter.exists(f)) await this.app.vault.adapter.remove(f);
			} catch (e) {
				console.warn('FleurAnnotation: 删除批注数据失败', f, e);
			}
		}
	}

	/** hash 文件名 → 笔记路径（仅配置目录模式的存量 sidecar 有意义） */
	async listLegacySidecars(): Promise<Array<{ file: string; fileId: string }>> {
		const out: Array<{ file: string; fileId: string }> = [];
		try {
			const files = (await this.app.vault.adapter.list(this.baseDir())).files.filter(
				f => f.endsWith('.json') && !CORRUPT_BACKUP_RE.test(f),
			);
			for (const f of files) {
				try {
					const data = JSON.parse(await this.app.vault.adapter.read(f)) as MarkdownAnnotationData;
					if (data?.fileId) out.push({ file: f, fileId: data.fileId });
				} catch {
					/* 跳过坏文件 */
				}
			}
		} catch {
			/* 目录不存在 */
		}
		return out;
	}
}
