import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type {
  NoteDocumentMeta,
  NoteDocumentCreateParams,
} from '../../api/noteDocumentContracts';
import {
  noteDocumentList,
  noteDocumentCreate,
  noteDocumentRename,
  noteDocumentDelete,
} from '../../api/noteApi';
import { subscribeNoteDocWritten } from '../../bridges/note-doc-written';
import {
  shouldConsumeScopedEvent,
  useLeafScope,
  useScopedSessionId,
} from '../../contexts/LeafScopeContext';

/** 历史存量默认文档 ID（doc_meta 出现前的单文档时代遗留；仅作自愈兜底） */
const LEGACY_DEFAULT_DOC_ID = 'strict-default';

export interface UseNoteDocumentManagerOptions {
  initialDocId?: string | null;
  flushPendingDraft?: () => Promise<void>;
  sessionId?: string | null;
  leafId?: string | null;
}

export interface UseNoteDocumentManagerResult {
  documents: NoteDocumentMeta[];
  allDocuments: NoteDocumentMeta[];
  activeDocId: string;
  activeDoc: NoteDocumentMeta | undefined;
  loading: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  switchDocument: (targetDocId: string) => Promise<void>;
  createDocument: (
    params?: NoteDocumentCreateParams
  ) => Promise<NoteDocumentMeta | null>;
  renameDocument: (docId: string, newTitle: string) => Promise<boolean>;
  deleteDocument: (docId: string) => Promise<boolean>;
  refreshList: () => Promise<void>;
  touchDocument: (docId: string, timestamp?: number) => void;
}

export function useNoteDocumentManager({
  initialDocId,
  flushPendingDraft,
  sessionId,
  leafId,
}: UseNoteDocumentManagerOptions): UseNoteDocumentManagerResult {
  const scope = useLeafScope();
  const scopedSessionId = useScopedSessionId(sessionId);
  const effectiveLeafId = leafId ?? scope.leafId;
  const scopeRef = useRef({
    sessionId: scopedSessionId,
    leafId: effectiveLeafId,
    isActive: scope.inLeafScope ? scope.isActive : undefined,
  });
  scopeRef.current = {
    sessionId: scopedSessionId,
    leafId: effectiveLeafId,
    isActive: scope.inLeafScope ? scope.isActive : undefined,
  };

  const [documents, setDocuments] = useState<NoteDocumentMeta[]>([]);
  const [activeDocId, setActiveDocId] = useState<string>(initialDocId || '');
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Generation Token 守卫引用
  const listGenerationRef = useRef<number>(0);
  const switchGenerationRef = useRef<number>(0);

  // 1. 获取工作区全量文档列表（包含空库冷启动自愈逻辑）
  const refreshList = useCallback(async () => {
    const currentSeq = ++listGenerationRef.current;
    try {
      const res = await noteDocumentList(false);
      if (currentSeq !== listGenerationRef.current) return;

      if (res.ok && res.documents) {
        if (res.documents.length === 0) {
          // 自愈机制：空库冷启动无任何笔记时，自动静默创建首篇默认笔记，防止 docId="" 导致白屏
          const createRes = await noteDocumentCreate({
            title: '未命名笔记',
          });
          if (currentSeq !== listGenerationRef.current) return;
          if (createRes.ok && createRes.document) {
            setDocuments([createRes.document]);
            setActiveDocId(createRes.document.id);
          } else {
            setActiveDocId(LEGACY_DEFAULT_DOC_ID);
          }
        } else {
          setDocuments(res.documents);
          // 如果当前没有激活的 docId 或不在列表中，自动激活最新一篇
          setActiveDocId((currentActive) => {
            if (
              currentActive &&
              res.documents!.some((d) => d.id === currentActive)
            ) {
              return currentActive;
            }
            return res.documents?.[0]?.id ?? '';
          });
        }
      }
    } finally {
      if (currentSeq === listGenerationRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // 初始化拉取并监听全局写入微事件联动刷新（避免幽灵总线）
  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // 触碰/更新文档更新时间戳（使抽屉列表中的相对时间响应式变为“刚刚”，并置顶）
  const touchDocument = useCallback((docId: string, timestamp?: number) => {
    if (!docId) return;
    const now = timestamp ?? Date.now();
    setDocuments((prev) => {
      const idx = prev.findIndex((d) => d.id === docId);
      const item = prev[idx];
      if (idx === -1 || !item) return prev;
      const target: NoteDocumentMeta = { ...item, updatedAt: now };
      const rest = prev.filter((_, i) => i !== idx);
      return [target, ...rest];
    });
  }, []);

  useEffect(() => {
    const unsubscribeWritten = subscribeNoteDocWritten((event) => {
      if (!shouldConsumeScopedEvent(event, scopeRef.current)) {
        return;
      }
      if (event.docId) {
        touchDocument(event.docId);
      }
      void refreshList();
    });
    return () => {
      unsubscribeWritten();
    };
  }, [refreshList, touchDocument]);

  // 2. 切换文档：500ms 超时刷盘防假死 + Generation Token 守卫
  const switchDocument = useCallback(
    async (targetDocId: string) => {
      if (!targetDocId || targetDocId === activeDocId) return;

      const currentSeq = ++switchGenerationRef.current;

      // 切换前脏数据强制可靠刷盘，杜绝 500ms 强杀丢数据
      if (flushPendingDraft) {
        try {
          await flushPendingDraft();
        } catch (err) {
          console.error(
            '[useNoteDocumentManager] switchDocument: flushPendingDraft error',
            err
          );
        }
      }

      if (currentSeq !== switchGenerationRef.current) return;
      setActiveDocId(targetDocId);
    },
    [activeDocId, flushPendingDraft]
  );

  // 3. 新建文档并立即切换激活（可靠等待草稿刷盘，杜绝 500ms 强杀）
  const createDocument = useCallback(
    async (
      params?: NoteDocumentCreateParams
    ): Promise<NoteDocumentMeta | null> => {
      // 新建前同样可靠刷盘既有草稿，杜绝 500ms 强杀丢数据
      if (flushPendingDraft) {
        try {
          await flushPendingDraft();
        } catch (err) {
          console.error(
            '[useNoteDocumentManager] createDocument: flushPendingDraft error',
            err
          );
        }
      }

      const res = await noteDocumentCreate({
        title: params?.title,
      });

      if (res.ok && res.document) {
        const created = res.document;
        setDocuments((prev) => [
          created,
          ...prev.filter((d) => d.id !== created.id),
        ]);
        setActiveDocId(created.id);
        return created;
      }
      return null;
    },
    [flushPendingDraft]
  );

  // 4. 重命名文档标题（统一 13 位毫秒级时间戳更新）
  const renameDocument = useCallback(
    async (docId: string, newTitle: string): Promise<boolean> => {
      const trimmed = newTitle.trim();
      const finalTitle = trimmed.length === 0 ? '未命名笔记' : trimmed;

      const res = await noteDocumentRename({ docId, title: finalTitle });
      if (res.ok) {
        setDocuments((prev) =>
          prev.map((d) =>
            d.id === docId
              ? {
                  ...d,
                  title: finalTitle,
                  updatedAt: res.updatedAt ?? Date.now(),
                }
              : d
          )
        );
        return true;
      }
      return false;
    },
    []
  );

  // 5. 彻底删除文档（纯函数更新，带删除最后一篇后的自愈机制）
  const deleteDocument = useCallback(
    async (docId: string): Promise<boolean> => {
      const res = await noteDocumentDelete({ docId, hardDelete: true });
      if (res.ok) {
        const nextDocs = documents.filter((d) => d.id !== docId);
        if (nextDocs.length === 0) {
          // 自愈保护：若删除了最后一篇文档，自动创建一篇默认空白笔记
          const createRes = await noteDocumentCreate({
            title: '未命名笔记',
          });
          if (createRes.ok && createRes.document) {
            setDocuments([createRes.document]);
            setActiveDocId(createRes.document.id);
          } else {
            setDocuments([]);
            setActiveDocId(LEGACY_DEFAULT_DOC_ID);
          }
        } else {
          setDocuments(nextDocs);
          if (activeDocId === docId) {
            setActiveDocId(nextDocs[0]?.id ?? '');
          }
        }
        return true;
      }
      return false;
    },
    [activeDocId, documents]
  );

  // 6. 搜索过滤后的视图列表（极简单轨：纯标题过滤）
  const filteredDocuments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => d.title.toLowerCase().includes(q));
  }, [documents, searchQuery]);

  const activeDoc = useMemo(
    () => documents.find((d) => d.id === activeDocId),
    [documents, activeDocId]
  );

  return {
    documents: filteredDocuments,
    allDocuments: documents,
    activeDocId,
    activeDoc,
    loading,
    searchQuery,
    setSearchQuery,
    switchDocument,
    createDocument,
    renameDocument,
    deleteDocument,
    refreshList,
    touchDocument,
  };
}

export default useNoteDocumentManager;
