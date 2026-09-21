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
}

export interface AIResult {
  id: string;
  text: string;
  question: string;
  answer: string;
  createdAt: number;
}

export interface MarkdownAnnotationData {
  fileId: string;
  annotations: Annotation[];
  aiResults?: AIResult[];
}
