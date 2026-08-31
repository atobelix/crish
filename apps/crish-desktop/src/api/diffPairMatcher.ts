/**
 * apps/crish-desktop/src/api/diffPairMatcher.ts
 *
 * 差异比对对偶配对与 Unified Diff 解析核心引擎（单一真源 SSOT）
 * 供 DiffCard (useDiffData.ts) 与 <widget-diff> (WidgetDiff.tsx) 统一调用。
 */

export type DiffChangeType = 'add' | 'delete' | 'context' | 'header';

export interface ParsedDiffLine {
  type: DiffChangeType;
  text: string;
  oldNum?: number;
  newNum?: number;
}

export interface SplitLinePair<T = ParsedDiffLine> {
  left: T | null;
  right: T | null;
  isHeader?: boolean;
}

/**
 * 健壮解析 Unified Diff 文本（过滤元数据头、支持 @@ Hunk 标记、支持 \ No newline）
 */
export function parseDiffText(rawText: string): ParsedDiffLine[] {
  if (!rawText) return [];
  const lines = rawText.split('\n');
  const result: ParsedDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // 1. 过滤 Git 差异元数据头行
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- a/') ||
      line.startsWith('+++ b/') ||
      line.startsWith('--- /dev/null') ||
      line.startsWith('+++ /dev/null') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ')
    ) {
      continue;
    }

    // 2. 忽略 "\ No newline at end of file" 标记
    if (line.startsWith('\\ No newline')) {
      continue;
    }

    // 3. Hunk Header 匹配 (@@ -o,c +n,c @@)
    if (line.startsWith('@@')) {
      const match = line.match(/@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
      if (match && match[1] && match[2]) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({ type: 'header', text: line });
      continue;
    }

    // 4. 新增行 (+)
    if (line.startsWith('+')) {
      result.push({
        type: 'add',
        text: line.slice(1),
        newNum: newLine++,
      });
      continue;
    }

    // 5. 删除行 (-)
    if (line.startsWith('-')) {
      result.push({
        type: 'delete',
        text: line.slice(1),
        oldNum: oldLine++,
      });
      continue;
    }

    // 6. 上下文行 (空格开头或普通行)
    const content = line.startsWith(' ') ? line.slice(1) : line;
    // 忽略最后一行单纯因为 split('\n') 产生的无意义末尾空行（若前面已有行）
    if (i === lines.length - 1 && content === '' && lines.length > 1) {
      continue;
    }

    result.push({
      type: 'context',
      text: content,
      oldNum: oldLine++,
      newNum: newLine++,
    });
  }

  return result;
}

/**
 * 泛型 Hunk 对偶配对器：将线性差异行切分为语义变更块，多余行填充 null 占位行
 */
export function buildSplitPairsFromGeneric<T>(
  items: T[],
  getType: (item: T) => DiffChangeType
): SplitLinePair<T>[] {
  const pairs: SplitLinePair<T>[] = [];
  let i = 0;

  while (i < items.length) {
    const cur = items[i];
    if (!cur) break;

    const curType = getType(cur);

    // 1. Hunk Header 行：独立跨栏居中
    if (curType === 'header') {
      pairs.push({ left: cur, right: cur, isHeader: true });
      i++;
      continue;
    }

    // 2. 上下文同行对齐
    if (curType === 'context') {
      pairs.push({ left: cur, right: cur });
      i++;
      continue;
    }

    // 3. 收集连续的变动块（Deletion 组与 Addition 组）
    const delGroup: T[] = [];
    const addGroup: T[] = [];

    while (i < items.length) {
      const item = items[i];
      if (!item) break;
      const type = getType(item);
      if (type === 'delete') {
        delGroup.push(item);
        i++;
      } else if (type === 'add') {
        addGroup.push(item);
        i++;
      } else {
        break;
      }
    }

    // 4. 对偶配对：取两组最大长度，短侧填充 null 占位行
    const maxLen = Math.max(delGroup.length, addGroup.length);
    for (let k = 0; k < maxLen; k++) {
      pairs.push({
        left: delGroup[k] ?? null,
        right: addGroup[k] ?? null,
      });
    }
  }

  return pairs;
}

/**
 * 为 ParsedDiffLine 提供的快捷对偶配对入口
 */
export function buildSplitLinePairs(lines: ParsedDiffLine[]): SplitLinePair<ParsedDiffLine>[] {
  return buildSplitPairsFromGeneric(lines, (l) => l.type);
}
