/**
 * 将 FileDiff 内存对象序列化为标准 Git Unified Patch 文本
 * 文件路径：apps/crish-desktop/src/components/diff/GitPatchFormatter.ts
 */
import type { FileDiff } from '../../store/types';

export function formatGitPatch(fileDiff: FileDiff): string {
  if (!fileDiff || !fileDiff.filePath) return '';
  const filePath = fileDiff.filePath.replace(/\\/g, '/');
  const lines: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  const changes = fileDiff.changes || [];
  if (changes.length > 0) {
    lines.push(
      `@@ -1,${fileDiff.deletions || 0} +1,${fileDiff.additions || 0} @@`
    );
    for (const change of changes) {
      const prefix =
        change.type === 'addition'
          ? '+'
          : change.type === 'deletion'
            ? '-'
            : ' ';
      lines.push(`${prefix}${change.content.replace(/^[+-]/, '')}`);
    }
  }

  return lines.join('\n');
}
