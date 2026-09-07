/**
 * 笔记文档元数据契约（列表、侧栏与搜索共用）
 * 遵循极简原则：统一 13 位毫秒级 Unix 时间戳，彻底剔除 tags/archived/pinned
 */
export interface NoteDocumentMeta {
  id: string;
  title: string;
  createdAt: number; // 13 位标准毫秒级 Unix 时间戳
  updatedAt: number; // 13 位标准毫秒级 Unix 时间戳
  blockCount: number;
  rev: number;
}

export interface NoteDocumentListParams {
  includeArchived?: boolean;
}

export interface NoteDocumentListResult {
  ok: boolean;
  documents?: NoteDocumentMeta[];
  totalCount?: number;
  code?: string;
  reason?: string;
}

export interface NoteDocumentCreateParams {
  title?: string;
  // audit-repair-202609 T10：砍除 initial_markdown——内容初始化唯一路径为
  // note_document_apply_md（正规 md→blocks 事务），直插单块属伪实现。
}

export interface NoteDocumentCreateResult {
  ok: boolean;
  document?: NoteDocumentMeta;
  code?: string;
  reason?: string;
}

export interface NoteDocumentRenameParams {
  docId: string;
  title: string;
}

export interface NoteDocumentRenameResult {
  ok: boolean;
  docId?: string;
  title?: string;
  updatedAt?: number;
  code?: string;
  reason?: string;
}

export interface NoteDocumentDeleteParams {
  docId: string;
  hardDelete?: boolean;
}

export interface NoteDocumentDeleteResult {
  ok: boolean;
  docId?: string;
  hardDeleted?: boolean;
  code?: string;
  reason?: string;
}
