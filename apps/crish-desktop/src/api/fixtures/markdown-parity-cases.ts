/* eslint-disable no-console */
/**
 * D0 residual — shared markdown fixtures for completed-message path parity.
 *
 * Consumers:
 *   - markdownRender.parity.test.ts (TS sync + async worker fallback)
 *   - crates/conex-markdown/tests/integration.rs (Rust SoT — keep structural
 *     contracts aligned; full port already lives there)
 *
 * Scope (small set, high ROI): lists, code fence, bold.
 * Do not expand into full GFM matrix here — that remains in lists.test.ts / integration.rs.
 */

export type ParityFixtureId = 'lists' | 'code_fence' | 'bold' | 'list_bold_code';

export interface ParityFixture {
  id: ParityFixtureId;
  /** Human label for failure messages */
  label: string;
  /** Markdown source (completed-message body, already stripped of stream noise) */
  md: string;
  /**
   * Structural contracts both engines must satisfy for completed-message HTML.
   * Not byte-for-byte (syntect vs highlight.js token spans may differ).
   */
  mustContain: string[];
  mustNotContain: string[];
  /** Regex patterns that must match (source string form for documentation) */
  mustMatch: string[];
  /** Tag / class counts that must not critically diverge */
  counts: Array<{ needle: string; exact?: number; min?: number }>;
}

/**
 * Intentional engine differences (document, do not assert equality on these):
 *
 * 1. Code token spans: Rust syntect vs TS highlight.js — inner `<span class="…">`
 *    markup may differ; outer `md-code-block` / `md-code-pre` / language class remain.
 * 2. Language badge text: TS may normalize `ts` → `typescript` via highlight.js;
 *    Rust may keep alias or map via its own table — accept either via regex.
 * 3. Sanitize layer: Rust ammonia at render; TS relies on escape + component-level
 *    DOMPurify for some raw tags — XSS body-escape still required on both.
 * 4. Byte-for-byte HTML equality is **not** required between Rust and TS.
 *    Byte equality **is** required between TS sync and async worker fallback
 *    (same parser: parseMarkdownToHtml).
 */
export const INTENTIONAL_DIFFERENCES = [
  'syntect vs highlight.js code token HTML (inner spans)',
  'language alias display (ts vs typescript) accepted via flexible match',
  'ammonia (Rust) vs escape/DOMPurify (TS) sanitize timing',
  'no full byte-for-byte Rust↔TS HTML equality requirement',
] as const;

export const PARITY_FIXTURES: readonly ParityFixture[] = [
  {
    id: 'lists',
    label: 'tight unordered list with bold markers',
    md: '### 改进建议优先级\n\n- **P0** 先修 markdown 重复列表\n- **P1** 表格窄屏换行\n- **P2** 其他 polish',
    mustContain: [
      '<h3 class="md-h3">改进建议优先级</h3>',
      '<strong>P0</strong>',
      '<strong>P1</strong>',
      '<strong>P2</strong>',
      'md-ul',
      'md-li',
    ],
    mustNotContain: ['markdown*'],
    mustMatch: [],
    counts: [
      { needle: '<ul', exact: 1 },
      { needle: '<li', exact: 3 },
    ],
  },
  {
    id: 'code_fence',
    label: 'fenced code with language + copy chrome',
    md: '```ts\nconst x = 1;\n```',
    mustContain: [
      'md-code-block',
      'md-code-lang',
      'md-code-copy',
      'md-code-pre',
    ],
    mustNotContain: ['data-copy=', '```'],
    mustMatch: [
      'language-(ts|typescript)',
      'md-code-lang"[^>]*>(ts|typescript)<',
    ],
    counts: [{ needle: 'md-code-block', exact: 1 }],
  },
  {
    id: 'bold',
    label: 'inline bold in paragraph',
    md: 'hello **world** and **P0** done',
    mustContain: [
      '<strong>world</strong>',
      '<strong>P0</strong>',
      'hello',
      'done',
    ],
    mustNotContain: ['**world**', '**P0**'],
    mustMatch: [],
    counts: [{ needle: '<strong>', exact: 2 }],
  },
  {
    id: 'list_bold_code',
    label: 'combined list + bold + fence (completed-message shape)',
    md: [
      '### Title',
      '',
      '- **bold item**',
      '- plain',
      '',
      '```js',
      'console.log(1);',
      '```',
      '',
      '**closing**',
    ].join('\n'),
    mustContain: [
      '<h3 class="md-h3">Title</h3>',
      '<strong>bold item</strong>',
      'plain',
      'md-code-block',
      '<strong>closing</strong>',
    ],
    mustNotContain: ['data-copy=', '**bold item**', '**closing**'],
    mustMatch: ['language-(js|javascript)'],
    counts: [
      { needle: '<ul', exact: 1 },
      { needle: '<li', exact: 2 },
      { needle: 'md-code-block', exact: 1 },
    ],
  },
] as const;
