// @vitest-environment node
/**
 * 思考占位剥离（stripThoughtPlaceholders / isThoughtPlaceholder）契约测试。
 *
 * 锁定：
 * - 占位/总结标题独立行（中文 + 英文 + 装饰变体）被剥离，正文保留；
 * - 区域内 3+ 空行折叠为 2；
 * - doc-start 前缀 / BOM 头先于行锚定正则剥离；
 * - 结果缓存：同输入同值。
 */
import { describe, expect, it } from 'vitest';
import {
  isThoughtPlaceholder,
  stripThoughtPlaceholders,
} from './markdownRenderLite';

/** 占位/总结标题 fixture 片段（中文 + 英文 + 装饰变体） */
const PLACEHOLDER_FRAGMENTS = [
  '正在思考中…\n',
  '正在处理…\n',
  '## 本轮总结\n',
  '## 本轮工作总结 ·\n',
  '## 本回合小结：\n',
  '**本轮总结：**\n',
  '**本轮小结：**\n',
  '【本回合回顾】\n',
  '[本轮小结]\n',
  '本轮总结\n',
  'Round summary\n',
  '## Session summary\n',
  '**Turn summary**\n',
];

const BODY_FRAGMENTS = [
  '完成了第一阶段的实现。\n',
  '- 修复了流式渲染的帧预算问题\n',
  '- 补充了对拍测试\n',
  '```ts\nconst budget = 8192;\n```\n',
  '跨帧边界的占位行与总结标题需要被剥离。\n',
  '性能指标：吞吐 2.4x，延迟 -38%。\n',
];

describe('stripThoughtPlaceholders', () => {
  it.each(PLACEHOLDER_FRAGMENTS)('占位行 %j 被剥离，后续正文保留', (frag) => {
    expect(stripThoughtPlaceholders(`${frag}正文保留\n`)).toBe('正文保留');
  });

  it.each(BODY_FRAGMENTS)('纯正文 %j 原样保留（仅去尾换行）', (body) => {
    expect(stripThoughtPlaceholders(body)).toBe(body.replace(/\n+$/, ''));
  });

  it('占位与正文交错：占位全部剥离，正文全部保留且顺序不变', () => {
    const parts: string[] = [];
    BODY_FRAGMENTS.forEach((body, i) => {
      parts.push(PLACEHOLDER_FRAGMENTS[i % PLACEHOLDER_FRAGMENTS.length]!);
      parts.push(body);
    });
    const out = stripThoughtPlaceholders(parts.join(''));
    let cursor = 0;
    for (const body of BODY_FRAGMENTS) {
      const idx = out.indexOf(body.replace(/\n+$/, ''), cursor);
      expect(idx).toBeGreaterThanOrEqual(cursor);
      cursor = idx;
    }
    expect(out).not.toMatch(/本轮总结|本回合小结|正在处理|summary/i);
  });

  it('占位行剥离后留空行，连续 3+ 空行折叠为 2', () => {
    expect(
      stripThoughtPlaceholders('正文第一行\n## 本轮总结\n正文最后\n')
    ).toBe('正文第一行\n\n正文最后');
    expect(stripThoughtPlaceholders('A行\n## 本轮总结\nB行\n')).toBe(
      'A行\n\nB行'
    );
    expect(stripThoughtPlaceholders('正文\n\n\n尾')).toBe('正文\n\n尾');
  });

  it('BOM 头与 doc-start 前缀长变体先于行锚定正则剥离', () => {
    expect(stripThoughtPlaceholders('\uFEFF正文第一行\n第二行\n')).toBe(
      '正文第一行\n第二行'
    );
    expect(stripThoughtPlaceholders('\uFEFF## 本轮总结\n正文\n')).toBe('正文');
    expect(
      stripThoughtPlaceholders('\uFEFF正在思考中……\n正在处理…\n\n正文第一行\n')
    ).toBe('正文第一行');
  });

  it('空输入 / 纯空白返回空串', () => {
    expect(stripThoughtPlaceholders('')).toBe('');
    expect(stripThoughtPlaceholders('  \n\t\n')).toBe('');
  });

  it('strip 结果缓存：同输入多次调用返回同值（N6 有界缓存）', () => {
    const text = '正在思考中…\n正文缓存测试\n';
    const a = stripThoughtPlaceholders(text);
    const b = stripThoughtPlaceholders(text);
    expect(a).toBe('正文缓存测试');
    expect(b).toBe(a);
  });
});

describe('isThoughtPlaceholder', () => {
  it('空值 / 纯占位 / 纯总结标题判定为占位', () => {
    expect(isThoughtPlaceholder(null)).toBe(true);
    expect(isThoughtPlaceholder(undefined)).toBe(true);
    expect(isThoughtPlaceholder('   ')).toBe(true);
    expect(isThoughtPlaceholder('正在处理…')).toBe(true);
    expect(isThoughtPlaceholder('正在思考中...')).toBe(true);
    expect(isThoughtPlaceholder('## 本轮总结\n')).toBe(true);
  });

  it('含实质正文判定为非占位', () => {
    expect(isThoughtPlaceholder('正文')).toBe(false);
    expect(isThoughtPlaceholder('## 本轮总结\n完成了实现')).toBe(false);
  });
});
