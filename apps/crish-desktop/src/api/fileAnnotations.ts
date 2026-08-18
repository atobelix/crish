/**
 * 选区批注：下一条用户消息注入模型（非常驻评论区）。
 *
 * 从 workspaceFsApi 拆分而来；承载 PendingFileAnnotation 类型与
 * add/count/take/format 四个纯函数 + 模块内可变状态（pendingAnnotations）。
 * workspaceFsApi hub 经 re-export 保持对外契约不变。
 */

export type PendingFileAnnotation = {
  id: string;
  path: string;
  selectedText: string;
  text: string;
  createdAt: number;
};

let pendingAnnotations: PendingFileAnnotation[] = [];

export function addPendingFileAnnotation(input: {
  path: string;
  selectedText: string;
  text: string;
}): PendingFileAnnotation {
  const a: PendingFileAnnotation = {
    id: `ann-${Date.now().toString(36)}`,
    path: input.path,
    selectedText: input.selectedText.trim().slice(0, 2000),
    text: input.text.trim(),
    createdAt: Date.now(),
  };
  pendingAnnotations = [a, ...pendingAnnotations].slice(0, 20);
  try {
    window.dispatchEvent(new CustomEvent('crish-file-annotations-changed'));
  } catch {
    /* swallow-ok: 批注变更事件分发失败不影响已入队的批注 */
  }
  return a;
}

export function countPendingFileAnnotations(): number {
  return pendingAnnotations.length;
}

/** 取出并清空待发送批注（发送用户消息时调用） */
export function takePendingFileAnnotations(): PendingFileAnnotation[] {
  const list = pendingAnnotations;
  pendingAnnotations = [];
  try {
    window.dispatchEvent(new CustomEvent('crish-file-annotations-changed'));
  } catch {
    /* swallow-ok: 批注清空事件分发失败不影响已取出的批注 */
  }
  return list;
}

/** 格式化为注入模型的上下文块 */
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
