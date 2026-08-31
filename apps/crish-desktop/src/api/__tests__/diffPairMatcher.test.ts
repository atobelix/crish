import { describe, it, expect } from 'vitest';
import {
  parseDiffText,
  buildSplitPairsFromGeneric,
  buildSplitLinePairs,
  type ParsedDiffLine,
} from '../diffPairMatcher';

describe('diffPairMatcher 核心算法套件', () => {
  it('健壮过滤标准 Unified Diff 元数据头，不产生伪增删行', () => {
    const raw = `diff --git a/src/app.ts b/src/app.ts
index e69de29..d95f3ad 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 const c = 3;`;
    const parsed = parseDiffText(raw);
    expect(parsed.length).toBe(4); // 1 header + 1 context + 1 add + 1 context
    expect(parsed[0]?.type).toBe('header');
    expect(parsed[1]?.text).toBe('const a = 1;');
    expect(parsed[1]?.type).toBe('context');
    expect(parsed[1]?.oldNum).toBe(1);
    expect(parsed[1]?.newNum).toBe(1);
    expect(parsed[2]?.type).toBe('add');
    expect(parsed[2]?.text).toBe('const b = 2;');
    expect(parsed[2]?.newNum).toBe(2);
    expect(parsed[3]?.type).toBe('context');
    expect(parsed[3]?.text).toBe('const c = 3;');
    expect(parsed[3]?.oldNum).toBe(2);
    expect(parsed[3]?.newNum).toBe(3);
  });

  it('健壮忽略 \\ No newline at end of file 标记', () => {
    const raw = `@@ -1,1 +1,1 @@
-old line
\\ No newline at end of file
+new line
\\ No newline at end of file`;
    const parsed = parseDiffText(raw);
    expect(parsed.length).toBe(3); // 1 header + 1 delete + 1 add
    expect(parsed[1]?.type).toBe('delete');
    expect(parsed[1]?.text).toBe('old line');
    expect(parsed[2]?.type).toBe('add');
    expect(parsed[2]?.text).toBe('new line');
  });

  it('过滤 new/deleted file mode 与 /dev/null 元数据', () => {
    const raw = `diff --git a/new-file.txt b/new-file.txt
new file mode 100644
--- /dev/null
+++ b/new-file.txt
@@ -0,0 +1,2 @@
+hello
+world`;
    const parsed = parseDiffText(raw);
    expect(parsed.length).toBe(3); // 1 header + 2 adds
    expect(parsed[0]?.type).toBe('header');
    expect(parsed[1]?.type).toBe('add');
    expect(parsed[1]?.newNum).toBe(1);
    expect(parsed[2]?.type).toBe('add');
    expect(parsed[2]?.newNum).toBe(2);
  });

  it('连续 3 行删除紧随 1 行新增时，产出 3 个 Pair，右侧后 2 个为 null 占位槽', () => {
    const lines: ParsedDiffLine[] = [
      { type: 'delete', text: 'del1', oldNum: 1 },
      { type: 'delete', text: 'del2', oldNum: 2 },
      { type: 'delete', text: 'del3', oldNum: 3 },
      { type: 'add', text: 'add1', newNum: 1 },
    ];
    const pairs = buildSplitLinePairs(lines);
    expect(pairs.length).toBe(3);
    expect(pairs[0]?.left?.text).toBe('del1');
    expect(pairs[0]?.right?.text).toBe('add1');
    expect(pairs[1]?.left?.text).toBe('del2');
    expect(pairs[1]?.right).toBeNull();
    expect(pairs[2]?.left?.text).toBe('del3');
    expect(pairs[2]?.right).toBeNull();
  });

  it('连续 1 行删除紧随 3 行新增时，产出 3 个 Pair，左侧后 2 个为 null 占位槽', () => {
    const lines: ParsedDiffLine[] = [
      { type: 'delete', text: 'del1', oldNum: 1 },
      { type: 'add', text: 'add1', newNum: 1 },
      { type: 'add', text: 'add2', newNum: 2 },
      { type: 'add', text: 'add3', newNum: 3 },
    ];
    const pairs = buildSplitLinePairs(lines);
    expect(pairs.length).toBe(3);
    expect(pairs[0]?.left?.text).toBe('del1');
    expect(pairs[0]?.right?.text).toBe('add1');
    expect(pairs[1]?.left).toBeNull();
    expect(pairs[1]?.right?.text).toBe('add2');
    expect(pairs[2]?.left).toBeNull();
    expect(pairs[2]?.right?.text).toBe('add3');
  });

  it('Header 与 Context 行在分栏中正确对齐', () => {
    const lines: ParsedDiffLine[] = [
      { type: 'header', text: '@@ -1,3 +1,3 @@' },
      { type: 'context', text: 'ctx1', oldNum: 1, newNum: 1 },
      { type: 'delete', text: 'del1', oldNum: 2 },
      { type: 'add', text: 'add1', newNum: 2 },
      { type: 'context', text: 'ctx2', oldNum: 3, newNum: 3 },
    ];
    const pairs = buildSplitLinePairs(lines);
    expect(pairs.length).toBe(4);
    expect(pairs[0]?.isHeader).toBe(true);
    expect(pairs[0]?.left?.text).toBe('@@ -1,3 +1,3 @@');
    expect(pairs[0]?.right?.text).toBe('@@ -1,3 +1,3 @@');
    expect(pairs[1]?.left?.text).toBe('ctx1');
    expect(pairs[1]?.right?.text).toBe('ctx1');
    expect(pairs[2]?.left?.text).toBe('del1');
    expect(pairs[2]?.right?.text).toBe('add1');
    expect(pairs[3]?.left?.text).toBe('ctx2');
    expect(pairs[3]?.right?.text).toBe('ctx2');
  });

  it('空输入或边界情况健壮返回空数组', () => {
    expect(parseDiffText('')).toEqual([]);
    expect(buildSplitLinePairs([])).toEqual([]);
    expect(buildSplitPairsFromGeneric([], () => 'context')).toEqual([]);
  });
});
