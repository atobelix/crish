/**
 * apps/crish-desktop/src/api/fileAnnotations.test.ts
 * 会话隔离批注暂存池契约测试（详案 02 §3.2 / 评审 02 §2.3）：
 * - 批注按 sessionId 物理隔离：A 会话的批注绝不会被 B 会话取走；
 * - take 仅清空目标会话池，其余会话零影响；
 * - 无目标会话时禁止落幽灵暂存（返回 null + 告警）。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPendingFileAnnotation,
  removePendingFileAnnotation,
  countPendingFileAnnotations,
  formatAnnotationsForModel,
  resetFileAnnotationsForTest,
  takePendingFileAnnotations,
  updatePendingFileAnnotationComment,
} from './fileAnnotations';
import { sessionRuntimeRegistry } from './SessionRuntimeRegistry';

const ann = (text: string) => ({
  path: 'C:/repo/src/a.ts',
  selectedText: 'const x = 1',
  text,
});

describe('fileAnnotations 会话隔离与附件协同', () => {
  beforeEach(() => {
    resetFileAnnotationsForTest();
    sessionRuntimeRegistry.remove('sess-a');
    sessionRuntimeRegistry.remove('sess-b');
    vi.clearAllMocks();
  });

  it('按 sessionId 物理隔离：A 会话批注不被 B 会话取走', () => {
    addPendingFileAnnotation(ann('A 的批注'), { targetSessionId: 'sess-a' });
    addPendingFileAnnotation(ann('B 的批注'), { targetSessionId: 'sess-b' });

    expect(countPendingFileAnnotations('sess-a')).toBe(1);
    expect(countPendingFileAnnotations('sess-b')).toBe(1);

    const takenB = takePendingFileAnnotations('sess-b');
    expect(takenB).toHaveLength(1);
    expect(takenB[0]!.text).toBe('B 的批注');

    // A 会话池不受影响
    expect(countPendingFileAnnotations('sess-a')).toBe(1);
    const takenA = takePendingFileAnnotations('sess-a');
    expect(takenA[0]!.text).toBe('A 的批注');
  });

  it('无目标会话时拒绝落幽灵暂存（返回 null + 告警）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = addPendingFileAnnotation(ann('孤儿批注'), {
      targetSessionId: '',
    });
    expect(a).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(countPendingFileAnnotations('')).toBe(0);
    warn.mockRestore();
  });

  it('添加瞬间挂载至会话附件区（作为附件展示供用户自由删除）', () => {
    const created = addPendingFileAnnotation(ann('批注内容'), {
      targetSessionId: 'sess-a',
    });
    expect(created).not.toBeNull();

    // 验证同步写入 sessionRuntimeRegistry attachments
    const atts = sessionRuntimeRegistry.get('sess-a').attachments;
    expect(atts).toHaveLength(1);
    expect(atts[0]?.name).toContain('批注 · a.ts');
    expect(atts[0]?.annotation?.id).toBe(created!.id);
    expect(atts[0]?.annotation?.comment).toBe('批注内容');

    // 用户在附件区删除批注
    const removed = removePendingFileAnnotation(created!.id, 'sess-a');
    expect(removed).toBe(true);
    expect(countPendingFileAnnotations('sess-a')).toBe(0);
    expect(sessionRuntimeRegistry.get('sess-a').attachments).toHaveLength(0);
  });

  it('formatAnnotationsForModel 单一来源：空列表返回空串', () => {
    expect(formatAnnotationsForModel([])).toBe('');
  });

  it('批注评论不可变更新：不原地 mutate 原对象', () => {
    const created = addPendingFileAnnotation(ann('旧评论'), {
      targetSessionId: 'sess-a',
    });
    expect(created).not.toBeNull();
    const before = sessionRuntimeRegistry.get('sess-a').attachments[0]!;
    const beforeAnn = before.annotation!;
    const ok = updatePendingFileAnnotationComment(created!.id, '新评论', 'sess-a');
    expect(ok).toBe(true);
    const after = sessionRuntimeRegistry.get('sess-a').attachments[0]!;
    expect(after).not.toBe(before);
    expect(after.annotation).not.toBe(beforeAnn);
    expect(after.annotation?.comment).toBe('新评论');
    expect(beforeAnn.comment).toBe('旧评论');
  });
});