/**
 * 选区批注：添加瞬间即派发对话流可见卡片，并在会话隔离暂存池中等候
 * 下一次发送注入模型（非常驻评论区）。
 *
 * 会话隔离（详案 02 §3.2 / 评审 02 §2.3）：清退模块级全局数组
 * （pendingAnnotations），改为按 sessionId 寻址的暂存池——会话 A 的
 * 批注绝不会被会话 B 的发送消费；添加瞬间经 ContextInjectionDispatcher
 * 派发 file_context 可见卡片（所见即所知），wire 文本仍由
 * assembleChatPayload 在发送时按会话取走注入（单一暂存源，双投影）。
 *
 * 从 workspaceFsApi 拆分而来；hub 经 re-export 保持对外契约不变。
 */

import { useSessionStore } from '../store/sessionStore';
import { sessionRuntimeRegistry, type Attachment } from './SessionRuntimeRegistry';
import type { ChatAttachment } from '../hooks/chat-stream/types';

export type PendingFileAnnotation = {
  id: string;
  path: string;
  selectedText: string;
  text: string;
  createdAt: number;
};

/** 单会话批注上限（防误触刷屏；与旧全局池口径一致） */
const PENDING_ANNOTATIONS_LIMIT = 20;

export const DRAFT_SESSION_KEY = '__composer_draft_session__';

/** 会话隔离暂存池（sessionId → 待发送批注，最新在前） */
const pendingBySession = new Map<string, PendingFileAnnotation[]>();

/** 批注变更事件（文件面板徽章刷新；UI 本地通知面，非跨会话暗流） */
const ANN_CHANGED_EVENT = 'crish-file-annotations-changed';

function notifyChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(ANN_CHANGED_EVENT));
  } catch {
    /* swallow-ok: 批注变更事件分发失败不影响已入池的批注 */
  }
}

/** 解析目标会话：显式指定优先；缺省未传时回落活跃会话或草稿会话（避免草稿态批注静默丢弃） */
function resolveSessionId(explicit?: string | null): string {
  if (explicit === '') return '';
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  try {
    const active = useSessionStore.getState().activeSessionId;
    return active && active.trim() ? active.trim() : DRAFT_SESSION_KEY;
  } catch {
    return DRAFT_SESSION_KEY;
  }
}



/** 路径短名（卡片标题展示用：取末段文件名） */
function shortName(path: string): string {
  const segs = path.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || path;
}

export function addPendingFileAnnotation(
  input: {
    path: string;
    selectedText: string;
    text: string;
  },
  opts?: { targetSessionId?: string | null }
): PendingFileAnnotation | null {
  const sid = resolveSessionId(opts?.targetSessionId);
  if (!sid) {
    console.warn('[fileAnnotations] 无目标会话，批注已忽略（不落幽灵暂存）');
    return null;
  }
  const a: PendingFileAnnotation = {
    id: `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    path: input.path,
    selectedText: input.selectedText.trim().slice(0, 2000),
    text: input.text.trim(),
    createdAt: Date.now(),
  };
  const list = pendingBySession.get(sid) ?? [];
  pendingBySession.set(sid, [a, ...list].slice(0, PENDING_ANNOTATIONS_LIMIT));
  notifyChanged();

  // 作为附件放入输入框附件区，用户可自由查看与删除；绝不在对话流注入退步的 injection-row-head
  const fileName = shortName(input.path);
  const snippet = a.text.length > 20 ? `${a.text.slice(0, 20)}…` : a.text;
  const attachName = `批注 · ${fileName} (${snippet})`;
  const chatAttachment: ChatAttachment = {
    id: a.id,
    name: attachName,
    path: a.path,
    text: `【代码选区批注: ${a.path}】\n选中内容:\n${a.selectedText}\n批注:\n${a.text}`,
    mime: 'text/x-annotation',
    annotation: {
      id: a.id,
      selectedText: a.selectedText,
      comment: a.text,
    },
  };

  const runtime = sessionRuntimeRegistry.get(sid);
  const existing = (runtime.attachments ?? []) as ChatAttachment[];
  sessionRuntimeRegistry.save(sid, {
    attachments: [
      ...existing.filter((x) => x.name !== attachName && x.annotation?.id !== a.id),
      chatAttachment,
    ] as Attachment[],
  });

  try {
    window.dispatchEvent(
      new CustomEvent('crish-attachments-changed', {
        detail: { sessionId: sid, attachment: chatAttachment },
      })
    );
  } catch {
    /* swallow-ok */
  }

  return a;
}

/** 删除指定待发送批注（用户在输入框附件区删除时触发） */
export function removePendingFileAnnotation(
  id: string,
  sessionId?: string | null
): boolean {
  const sid = resolveSessionId(sessionId);
  if (!sid) return false;
  const list = pendingBySession.get(sid);
  if (!list) return false;
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return false;
  if (next.length === 0) {
    pendingBySession.delete(sid);
  } else {
    pendingBySession.set(sid, next);
  }

  // 同步清退 sessionRuntimeRegistry 对应的 attachment
  const runtime = sessionRuntimeRegistry.get(sid);
  const existing = (runtime.attachments ?? []) as ChatAttachment[];
  const nextAtts = existing.filter(
    (att) => att.annotation?.id !== id && att.id !== id
  );
  if (nextAtts.length !== existing.length) {
    sessionRuntimeRegistry.save(sid, {
      attachments: nextAtts as Attachment[],
    });
    try {
      window.dispatchEvent(
        new CustomEvent('crish-attachments-changed', {
          detail: { sessionId: sid },
        })
      );
    } catch {
      /* swallow-ok */
    }
  }

  notifyChanged();
  return true;
}

/** 更新待发送批注的评论内容（用户在输入框悬浮卡片中编辑时触发） */
export function updatePendingFileAnnotationComment(
  id: string,
  newComment: string,
  sessionId?: string | null
): boolean {
  const sid = resolveSessionId(sessionId);
  if (!sid) return false;
  const list = pendingBySession.get(sid);
  if (list) {
    const itemIdx = list.findIndex((a) => a.id === id);
    if (itemIdx >= 0) {
      const item = list[itemIdx]!;
      pendingBySession.set(
        sid,
        list.map((a, i) =>
          i === itemIdx ? { ...item, text: newComment.trim() } : a
        )
      );
    }
  }

  const runtime = sessionRuntimeRegistry.get(sid);
  const existing = (runtime.attachments ?? []) as ChatAttachment[];
  const idx = existing.findIndex((att) => att.annotation?.id === id || att.id === id);
  if (idx < 0) return false;
  const target = existing[idx]!;
  if (!target.annotation) return false;
  const trimmed = newComment.trim();
  const nextAttachment: ChatAttachment = {
    ...target,
    text: `【代码选区批注: ${target.path || target.name}】
选中内容:
${target.annotation.selectedText}
批注:
${trimmed}`,
    annotation: {
      ...target.annotation,
      comment: trimmed,
    },
  };
  const nextAtts = existing.map((att, i) => (i === idx ? nextAttachment : att));
  sessionRuntimeRegistry.save(sid, {
    attachments: nextAtts as Attachment[],
  });
  try {
    window.dispatchEvent(
      new CustomEvent('crish-attachments-changed', {
        detail: { sessionId: sid, attachment: nextAttachment },
      })
    );
  } catch {
    /* swallow-ok */
  }
  notifyChanged();
  return true;
}

export function countPendingFileAnnotations(sessionId?: string | null): number {
  return (pendingBySession.get(resolveSessionId(sessionId)) ?? []).length;
}

/** 取出并清空该会话的待发送批注（发送用户消息时调用；他 session 池不受影响） */
export function takePendingFileAnnotations(
  sessionId?: string | null
): PendingFileAnnotation[] {
  const sid = resolveSessionId(sessionId);
  if (!sid) return [];
  const list = pendingBySession.get(sid) ?? [];
  pendingBySession.delete(sid);
  if (list.length) {
    const runtime = sessionRuntimeRegistry.get(sid);
    const existing = (runtime.attachments ?? []) as ChatAttachment[];
    const nextAtts = existing.filter((att) => !att.annotation);
    if (nextAtts.length !== existing.length) {
      sessionRuntimeRegistry.save(sid, {
        attachments: nextAtts as Attachment[],
      });
      try {
        window.dispatchEvent(
          new CustomEvent('crish-attachments-changed', {
            detail: { sessionId: sid },
          })
        );
      } catch {
        /* swallow-ok */
      }
    }
    notifyChanged();
  }
  return list;
}

/** 格式化为注入模型的上下文块（卡片正文与 wire 文本的单一来源） */
export function formatAnnotationsForModel(list: PendingFileAnnotation[]): string {
  if (!list.length) return '';
  const parts = list.map((a, i) => {
    const path = a.path;
    const sel = a.selectedText.length > 800 ? `${a.selectedText.slice(0, 800)}…` : a.selectedText;
    return [
      `### 文件批注 ${i + 1}`,
      `路径: ${path}`,
      `选中内容:`,
      '```',
      sel,
      '```',
      `用户批注: ${a.text}`,
    ].join('\n');
  });
  return (
    `<file_annotations>\n以下批注来自用户在文件面板中对选区的标注，请优先参考。\n\n` +
    parts.join('\n\n') +
    `\n</file_annotations>`
  );
}

/** 测试重置（清空全部会话池） */
export function resetFileAnnotationsForTest(): void {
  pendingBySession.clear();
}
