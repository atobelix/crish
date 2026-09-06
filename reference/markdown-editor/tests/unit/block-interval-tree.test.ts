import { describe, it, expect } from 'vitest';
import { BlockIntervalTree } from '../../src/core/BlockIntervalTree';

describe('BlockIntervalTree 块区间拓扑树', () => {
  it('正确解析单行 Callout 头部', () => {
    const lines = [
      '# 标题',
      '> [!NOTE] 提示标题',
      '普通正文',
    ];
    const tree = new BlockIntervalTree(lines);
    const ctx = tree.getCalloutContextAt(1);
    expect(ctx).toEqual({
      type: 'note',
      title: '提示标题',
      isHeader: true,
    });
    expect(tree.getCalloutContextAt(0)).toBeNull();
    expect(tree.getCalloutContextAt(2)).toBeNull();
  });

  it('突破 50 行限制：正确解析超过 100 行的超长 Callout 引用', () => {
    const lines: string[] = ['> [!WARNING] 超长大块警告'];
    for (let i = 0; i < 120; i++) {
      lines.push(`> 这是警告第 ${i + 1} 行内容`);
    }
    lines.push('结束正文');

    const tree = new BlockIntervalTree(lines);
    
    // 第 0 行是头部
    expect(tree.getCalloutContextAt(0)).toEqual({
      type: 'warning',
      title: '超长大块警告',
      isHeader: true,
    });

    // 第 40 行
    expect(tree.getCalloutContextAt(40)).toEqual({
      type: 'warning',
      title: '超长大块警告',
      isHeader: false,
    });

    // 第 90 行（已远超旧实现 50 行截断红线）
    expect(tree.getCalloutContextAt(90)).toEqual({
      type: 'warning',
      title: '超长大块警告',
      isHeader: false,
    });

    // 第 120 行
    expect(tree.getCalloutContextAt(120)).toEqual({
      type: 'warning',
      title: '超长大块警告',
      isHeader: false,
    });

    // 第 121 行结束
    expect(tree.getCalloutContextAt(121)).toBeNull();
  });

  it('空行能够正确阻断并闭合 Callout', () => {
    const lines = [
      '> [!TIP] 技巧',
      '> 内容 1',
      '',
      '> [!IMPORTANT] 重要通知',
      '> 内容 2',
    ];
    const tree = new BlockIntervalTree(lines);
    expect(tree.getCalloutContextAt(0)?.type).toBe('tip');
    expect(tree.getCalloutContextAt(1)?.type).toBe('tip');
    expect(tree.getCalloutContextAt(2)).toBeNull();
    expect(tree.getCalloutContextAt(3)?.type).toBe('important');
    expect(tree.getCalloutContextAt(4)?.type).toBe('important');
  });

  it('正确识别围栏代码块', () => {
    const lines = [
      '```typescript',
      'const a = 1;',
      'const b = 2;',
      '```',
      '正文',
    ];
    const tree = new BlockIntervalTree(lines);
    const block = tree.getBlockAt(1);
    expect(block).not.toBeNull();
    expect(block?.type).toBe('code_block');
    expect(block?.startLine).toBe(0);
    expect(block?.endLine).toBe(3);
    expect(block?.meta?.lang).toBe('typescript');
  });
});
