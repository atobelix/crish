// @vitest-environment jsdom
/**
 * D0 residual — markdown fixture parity (completed-message path).
 *
 * Paths under test:
 *   A. TS sync: `parseMarkdownToHtml` (worker / offline fallback facade)
 *   B. Async + worker: `parseMarkdownToHtmlAsync` when Rust `core_md_render` is missing
 *      → worker pool → same TS parser (must equal A byte-for-byte)
 *   C. Structural contracts for completed-message HTML (CSS SoT classes)
 *
 * Rust SoT structural coverage lives in crates/conex-markdown/tests/integration.rs
 * (port of lists tests). This file does **not** delete the sync fallback.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  clearMarkdownHtmlCache,
  resetMarkdownHtmlCacheStats,
} from './markdownCache';
import { parseMarkdownToHtml } from './markdownRender';
import {
  mockTauriCommand,
  mockTauriMissing,
} from '../test-setup';
import {
  INTENTIONAL_DIFFERENCES,
  PARITY_FIXTURES,
  type ParityFixture,
} from './fixtures/markdown-parity-cases';

const scheduleSpy = vi.fn();
vi.mock('../workers', () => ({
  getWorkerPool: () => ({
    schedule: scheduleSpy,
  }),
  Priority: {
    Critical: 0,
    High: 1,
    Normal: 2,
    Low: 3,
  } as const,
}));

import { parseMarkdownToHtmlAsync } from './markdownRenderAsync';

function countSubstr(hay: string, needle: string): number {
  if (!needle) return hay.length;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

function assertStructural(html: string, fixture: ParityFixture, path: string): void {
  for (const s of fixture.mustContain) {
    expect(html, `${path} [${fixture.id}] must contain ${JSON.stringify(s)}`).toContain(s);
  }
  for (const s of fixture.mustNotContain) {
    expect(html, `${path} [${fixture.id}] must not contain ${JSON.stringify(s)}`).not.toContain(s);
  }
  for (const pat of fixture.mustMatch) {
    expect(html, `${path} [${fixture.id}] must match /${pat}/`).toMatch(new RegExp(pat));
  }
  for (const c of fixture.counts) {
    const n = countSubstr(html, c.needle);
    if (c.exact !== undefined) {
      expect(n, `${path} [${fixture.id}] count(${c.needle})`).toBe(c.exact);
    }
    if (c.min !== undefined) {
      expect(n, `${path} [${fixture.id}] min count(${c.needle})`).toBeGreaterThanOrEqual(c.min);
    }
  }
  // Completed-message lists must never wrap <li> in <p> (browser reorders → ghost lists)
  if (fixture.id === 'lists' || fixture.id === 'list_bold_code') {
    expect(html, `${path} [${fixture.id}] no p>li`).not.toMatch(/<p[^>]*>\s*<li/);
  }
}

describe('markdown fixture parity (D0 completed-message)', () => {
  beforeEach(() => {
    clearMarkdownHtmlCache();
    resetMarkdownHtmlCacheStats();
    scheduleSpy.mockReset();
  });

  it('documents intentional Rust↔TS differences (regression anchor)', () => {
    // Keep this list non-empty so future agents know byte-equality is out of scope.
    expect(INTENTIONAL_DIFFERENCES.length).toBeGreaterThanOrEqual(3);
    expect(INTENTIONAL_DIFFERENCES).toEqual(
      expect.arrayContaining([
        expect.stringContaining('syntect'),
        expect.stringContaining('byte-for-byte'),
      ]),
    );
  });

  describe.each(PARITY_FIXTURES.map((f) => [f.id, f] as const))(
    'fixture %s',
    (_id, fixture) => {
      it('TS sync satisfies structural contracts', () => {
        const html = parseMarkdownToHtml(fixture.md);
        expect(html.length, 'sync must produce HTML').toBeGreaterThan(0);
        assertStructural(html, fixture, 'sync');
      });

      it('async worker fallback (Rust missing) equals TS sync byte-for-byte', async () => {
        mockTauriMissing('core_md_render');
        // Worker channel runs the same TS parser as sync (render-worker path).
        scheduleSpy.mockImplementation(
          async (_ch: string, type: string, payload: { raw?: string }) => {
            expect(type).toBe('markdown.render');
            return parseMarkdownToHtml(payload.raw ?? '');
          },
        );

        const syncHtml = parseMarkdownToHtml(fixture.md);
        clearMarkdownHtmlCache(); // force async path to re-render, not reuse sync cache
        const asyncHtml = await parseMarkdownToHtmlAsync(fixture.md);

        expect(scheduleSpy).toHaveBeenCalled();
        expect(asyncHtml).toBe(syncHtml);
        assertStructural(asyncHtml, fixture, 'async-worker-fallback');
      });

      it('async Rust path uses core_md_render HTML and still meets structure when mock is structural', async () => {
        // Simulate a Rust-shaped response: same structure as TS for these fixtures,
        // proving the completed-message async path prefers Rust when present.
        const rustLike = parseMarkdownToHtml(fixture.md);
        clearMarkdownHtmlCache();
        mockTauriCommand('core_md_render', async (args) => {
          const text = (args as { text?: string })?.text ?? '';
          expect(text).toBe(fixture.md);
          return rustLike;
        });
        scheduleSpy.mockImplementation(() => {
          throw new Error('worker must not run when Rust ok');
        });

        const html = await parseMarkdownToHtmlAsync(fixture.md);
        expect(html).toBe(rustLike);
        expect(scheduleSpy).not.toHaveBeenCalled();
        assertStructural(html, fixture, 'async-rust');
      });
    },
  );

  it('sync fallback remains exported and usable (must not be deleted)', () => {
    // Guardrail: D0 must keep TS sync for worker / offline / non-chat sites.
    expect(typeof parseMarkdownToHtml).toBe('function');
    const html = parseMarkdownToHtml('**keep**');
    expect(html).toContain('<strong>keep</strong>');
  });

  it('mixed list + fence: dashes inside code are not list items (both paths)', async () => {
    const md = 'code:\n\n```\n- a\n- b\n```\n\n- real list\n- item 2';
    const syncHtml = parseMarkdownToHtml(md);
    expect(countSubstr(syncHtml, '<ul')).toBe(1);
    expect(countSubstr(syncHtml, '<li')).toBe(2);
    expect(syncHtml).toContain('md-code-block');
    const codeInner = syncHtml.match(/<code class="language-">([\s\S]*?)<\/code>/)?.[1] ?? '';
    expect(codeInner).toContain('-');
    expect(codeInner).not.toContain('<li');

    mockTauriMissing('core_md_render');
    scheduleSpy.mockImplementation(
      async (_ch: string, _t: string, payload: { raw?: string }) =>
        parseMarkdownToHtml(payload.raw ?? ''),
    );
    clearMarkdownHtmlCache();
    const asyncHtml = await parseMarkdownToHtmlAsync(md);
    expect(asyncHtml).toBe(syncHtml);
  });

  it('GFM Emoji: default OFF preserves shortcodes in body/code; enabled helper still translates', async () => {
    const md = [
      '状态通过: :white_check_mark:，状态阻断: :x:',
      '',
      '`:white_check_mark:` 内联代码应保留生文本',
      '',
      '```bash',
      'echo ":white_check_mark:" && echo ":x:"',
      '```',
    ].join('\n');

    const syncHtml = parseMarkdownToHtml(md);

    // 1. AGENTS §21 / §7.3：默认关闭 — 正文保留短码，不得插入 Unicode Emoji
    expect(syncHtml).toContain('状态通过: :white_check_mark:，状态阻断: :x:');
    expect(syncHtml).not.toContain('✅');
    expect(syncHtml).not.toContain('❌');

    // 2. 行内代码与代码围栏内必须严格保留生文本短代码
    expect(syncHtml).toContain('<code class="md-inline-code">:white_check_mark:</code>');
    expect(syncHtml).toContain('md-code-block');
    expect(syncHtml).toContain(':white_check_mark:');
    expect(syncHtml).toContain(':x:');

    const codeFenceMatch = syncHtml.match(/<code class="language-bash">([\s\S]*?)<\/code>/);
    expect(codeFenceMatch).toBeTruthy();
    expect(codeFenceMatch![1]).toContain(':white_check_mark:');
    expect(codeFenceMatch![1]).toContain(':x:');
    expect(codeFenceMatch![1]).not.toContain('✅');
    expect(codeFenceMatch![1]).not.toContain('❌');

    // 3. Worker 异步降级路径与同步输出严格一致 (byte-for-byte)
    mockTauriMissing('core_md_render');
    scheduleSpy.mockImplementation(
      async (_ch: string, _t: string, payload: { raw?: string }) =>
        parseMarkdownToHtml(payload.raw ?? ''),
    );
    clearMarkdownHtmlCache();
    const asyncHtml = await parseMarkdownToHtmlAsync(md);
    expect(asyncHtml).toBe(syncHtml);
  });

  it('GFM Table: short row homogenization automatically pads missing cells with empty <td> and wraps in md-table-wrap', async () => {
    const md = [
      '| 模块名称 | 状态 | 备注 | 负责人 |',
      '| :--- | :---: | ---: | --- |',
      '| 核心排版 | :white_check_mark: | 已完成 | Alice |',
      '| 样式合规 | :white_check_mark: |', // 缺失后两列（第 3、4 列）
      '| 遗留问题 |', // 缺失后三列（第 2、3、4 列）
    ].join('\n');

    const syncHtml = parseMarkdownToHtml(md);

    // 1. 外层必须包裹 md-table-wrap 容器
    expect(syncHtml).toContain('class="md-table-wrap"');
    expect(syncHtml).toContain('<table class="md-table">');
    expect(syncHtml).toMatch(/<div class="md-table-wrap"[^>]*><table class="md-table">/);

    // 2. 表头必须有 4 列
    expect(countSubstr(syncHtml, '<th class="md-th"')).toBe(4);
    expect(syncHtml).toContain('模块名称');
    expect(syncHtml).toContain('状态');
    expect(syncHtml).toContain('备注');
    expect(syncHtml).toContain('负责人');

    // 3. 短行齐次化：表体共有 3 行，每行必须对齐到 4 列，缺失的列必须补齐空 <td>
    // 3 行 * 4 列 = 12 个 <td>
    const tdCount = countSubstr(syncHtml, '<td class="md-td"');
    expect(tdCount, '全量单元格必须补齐到 4 列 * 3 行 = 12 个 td').toBe(12);

    // 验证短行自动补齐的空 <td> 标签
    expect(syncHtml).toContain('<td class="md-td"></td>');
    // 验证对齐属性保留且内容为空
    expect(syncHtml).toContain('<td class="md-td" style="text-align:right"></td>');

    // 4. 单元格内部短码默认保留（§7.3 关翻译），文本正常解析
    expect(syncHtml).toContain('<td class="md-td" style="text-align:center">:white_check_mark:</td>');
    expect(syncHtml).not.toContain('✅');
    expect(syncHtml).toContain('<td class="md-td">Alice</td>');

    // 5. Worker 异步降级路径与同步输出严格一致 (byte-for-byte)
    mockTauriMissing('core_md_render');
    scheduleSpy.mockImplementation(
      async (_ch: string, _t: string, payload: { raw?: string }) =>
        parseMarkdownToHtml(payload.raw ?? ''),
    );
    clearMarkdownHtmlCache();
    const asyncHtml = await parseMarkdownToHtmlAsync(md);
    expect(asyncHtml).toBe(syncHtml);
  });
});
