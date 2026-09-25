// 类型定义
export interface Annotation {
  id: string;
  type: 'highlight' | 'underline' | 'comment';
  line?: number;  // 行号（从0开始）
  occurrence?: number;  // 同文本多次出现时的第几处（0-based），用于定位/删除正确的包裹
  text: string;
  comment?: string;
  color?: string;
  underlineStyle?: 'solid' | 'dashed' | 'dotted' | 'wavy';
  createdAt: number;
  /** 最后修改时间（多端同步合并时按此取新；老数据缺省回落 createdAt） */
  updatedAt?: number;
  /** 墓碑：非空表示已删除。跨设备同步下删除不物理移除——否则另一端的
   *  存活副本会在合并取并集时被「救回来」。渲染一律过滤墓碑。 */
  deletedAt?: number;
}

export interface AIResult {
  id: string;
  text: string;
  question: string;
  answer: string;
  createdAt: number;
  /** 墓碑，语义同 Annotation.deletedAt */
  deletedAt?: number;
}

export interface MarkdownAnnotationData {
  fileId: string;
  annotations: Annotation[];
  aiResults?: AIResult[];
}
