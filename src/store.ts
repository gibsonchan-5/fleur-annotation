// 数据存储层
import { App, TFile, normalizePath } from 'obsidian';
import type { Annotation, MarkdownAnnotationData, AIResult } from './types';

export class AnnotationStore {
  private baseDir: string;

  constructor(private app: App, private pluginId: string) {
    this.baseDir = `${app.vault.configDir}/plugins/${pluginId}/data`;
  }

  private getFilePath(mdPath: string): string {
    const hash = this.hashPath(mdPath);
    return normalizePath(`${this.baseDir}/${hash}.json`);
  }

  private hashPath(path: string): string {
    return path.replace(/[^a-zA-Z0-9]/g, '_');
  }

  async ensureDir(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.baseDir))) {
      await this.app.vault.adapter.mkdir(this.baseDir);
    }
  }

  async load(mdPath: string): Promise<MarkdownAnnotationData> {
    await this.ensureDir();
    const filePath = this.getFilePath(mdPath);

    try {
      if (await this.app.vault.adapter.exists(filePath)) {
        const content = await this.app.vault.adapter.read(filePath);
        return JSON.parse(content);
      }
    } catch (e) {
      console.error('加载标注数据失败:', e);
    }

    return { fileId: mdPath, annotations: [] };
  }

  async save(data: MarkdownAnnotationData): Promise<void> {
    await this.ensureDir();
    const filePath = this.getFilePath(data.fileId);
    await this.app.vault.adapter.write(filePath, JSON.stringify(data, null, 2));
  }

  async addAnnotation(mdPath: string, annotation: Annotation): Promise<void> {
    const data = await this.load(mdPath);
    data.annotations.push(annotation);
    await this.save(data);
  }

  async getAnnotations(mdPath: string): Promise<Annotation[]> {
    const data = await this.load(mdPath);
    return data.annotations;
  }

  async deleteAnnotation(mdPath: string, annotationId: string): Promise<void> {
    const data = await this.load(mdPath);
    data.annotations = data.annotations.filter(a => a.id !== annotationId);
    await this.save(data);
  }

  async updateAnnotation(mdPath: string, annotation: Annotation): Promise<void> {
    const data = await this.load(mdPath);
    const index = data.annotations.findIndex(a => a.id === annotation.id);
    if (index !== -1) {
      data.annotations[index] = annotation;
      await this.save(data);
    }
  }

  async removeAnnotation(mdPath: string, annotationId: string): Promise<void> {
    const data = await this.load(mdPath);
    data.annotations = data.annotations.filter(a => a.id !== annotationId);
    await this.save(data);
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
    const data = await this.load(mdPath);
    if (data.aiResults) {
      data.aiResults = data.aiResults.filter(r => r.id !== resultId);
      await this.save(data);
    }
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
      if (annotations.length === 0 && aiResults.length === 0) {
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

  /**
   * 文件夹被重命名/移动时，批量迁移其下所有文件的批注。
   *
   * @returns 迁移的批注文件数
   */
  async migrateFolder(oldPath: string, newPath: string): Promise<number> {
    const prefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
    let migrated = 0;
    try {
      const listing = await this.app.vault.adapter.list(this.baseDir);
      for (const f of listing.files) {
        if (!f.endsWith('.json')) continue;
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
}
