/**
* apps/crish-desktop/src/components/chat-message/chatSpacingScale.contract.test.ts
*
* 2026-11-06 间距调研（调研1）实测总账的
* 自动化固化。调研结论：上下间距不一致不是某处写错，而是行盒 / 流 /
* 段内 / md 排版等制度各管一层、从未合成一把尺。本契约把五层刻度成文
* 为代码侧单一事实，并逐层钉住「数值 × 归属文件 × 归属 token/规则」，
* 任何一层被改动或再分叉，CI 立即红。
*
* 五层刻度（默认密度、浅色实测；数值的唯一真源是各归属文件，本表只索引）：
*
* L1 列表几何层（归属 chatScrollGeometry.ts / ChatTimeSeparator）
* 列表顶衬 48 / 底衬 16（CHAT_SCROLL_PAD_TOP/BOTTOM，TS 常量单轨）；
* 时间分隔块 30.6 = 上衬 8（--space-2）+ 行盒 18.6（--font-size-meta
* 12px × --lh-prose 1.55）+ 下衬 4（--space-1）。
* L2 行盒层（归属 tokens-space.css / ChatMessageRow.module.css）
* 轮 pitch 52 = meta 槽 32（margin-top 4 = --space-1 + min-height 28）
* + 行 padding-bottom 20（--chat-row-gap 默认密度；紧凑 16 / 宽松 24）。
* L3 流层（归属 MessageContent.module.css）
* 流内相邻段盒间隙恒 8（.assistantTimelineStream gap = --space-2）。
* L4 段内层（归属 FoldableProcessSection / tokens-base / MessageContent /
* ReasoningRow）
* 段内相邻 0（.sectionBodyInner /.sectionFadeInner gap: 0）；
* 组内工具行间 3（--tool-row-gap）；段内叙述 margin-block 6
* （--space-1_5）；思考体纵向 padding 6/6。
* L5 md 排版层（归属 markdown-typography.css chat 变体 / tokens-components）
* 段后距 0.82em（--md-paragraph-margin-bottom，14px 下 ≈11.48）；
* 正文块间 0.65em（--md-block-gap，≈9.1，由.assistantText 的
* margin-block-end 承载、末块归零）。
* 流内收口（2026-11-06 间距修复批方向②）：渲染根直属末段的段后距
* 在流层正文（.contentText）与思考展开体（.reasoningContent）内
* 归零——否则可见间距按方向分叉（8 / 19.4 / 15.5、块间 9.1 被叠成
* 20.6）；归零只许存在于这两个聊天流表面，排版层全局规则不动。
*
* 本文件只做源码级断言，不渲染组件。
*/

import { readFileSync} from 'node:fs';
import { resolve} from 'node:path';
import { describe, expect, it} from 'vitest';

const CHAT_MESSAGE = resolve(__dirname, '.');
const CHAT_ROW = resolve(__dirname, '../chat-message-row');
const CHAT_LIST = resolve(__dirname, '../chat-message-list');
const STYLES = resolve(__dirname, '../../styles');

/** 读取 CSS 并剥离注释（注释内的反例文本不得被误判为真实声明） */
function readCss(...segments: string[]): string {
const raw = readFileSync(resolve(...segments), 'utf8');
return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

function readRaw(...segments: string[]): string {
return readFileSync(resolve(...segments), 'utf8');
}

/** 提取「独立平铺选择器」的声明块；未命中返回空串（由调用方断言非空） */
function block(css: string, selector: string): string {
const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
return css.match(new RegExp(`^${escaped}\\s*\\{[^}]*\\}`, 'm'))?.[0]?? '';
}

const contentCss = readCss(CHAT_MESSAGE, 'MessageContent.module.css');
const foldCss = readCss(CHAT_MESSAGE, 'FoldableProcessSection.module.css');
const reasoningCss = readCss(CHAT_ROW, 'ReasoningRow.module.css');
const rowCss = readCss(CHAT_ROW, 'ChatMessageRow.module.css');
const separatorCss = readCss(CHAT_LIST, 'ChatTimeSeparator.module.css');
const listCssRaw = readRaw(CHAT_LIST, 'ChatMessageList.module.css');
const geometryTs = readRaw(CHAT_LIST, 'chatScrollGeometry.ts');
const mdCss = readCss(STYLES, 'markdown-typography.css');
const tokensSpace = readCss(STYLES, 'tokens-space.css');
const tokensBase = readCss(STYLES, 'tokens-base.css');
const tokensComponents = readCss(STYLES, 'tokens-components.css');

/* ═══════════════════════════════════════════════════════════════════
* L1 列表几何层
* ═══════════════════════════════════════════════════════════════════ */
describe('L1 列表几何层（chatScrollGeometry 单轨）', () => {
it('顶/底衬距 TS 常量：48 / 16', () => {
expect(geometryTs).toMatch(/export const CHAT_SCROLL_PAD_TOP = 48;/);
expect(geometryTs).toMatch(/export const CHAT_SCROLL_PAD_BOTTOM = 16;/);
});

it('时间分隔块构成：padding --space-2/--space-1 + meta 字号 × prose 行高（实测 30.6）', () => {
const b = block(separatorCss, '.separator');
expect(b).not.toBe('');
expect(b).toMatch(/padding:\s*var\(--space-2\)\s+0\s+var\(--space-1\)/);
expect(b).toMatch(/font-size:\s*var\(--font-size-meta\)/);
expect(b).toMatch(/line-height:\s*var\(--lh-prose\)/);
});
});

/* ═══════════════════════════════════════════════════════════════════
* L2 行盒层（轮 pitch 52 = meta 槽 32 + 行距 20）
* ═══════════════════════════════════════════════════════════════════ */
describe('L2 行盒层', () => {
it('--chat-row-gap 三档齐备且各一份：默认 20 / 紧凑 16 / 宽松 24', () => {
for (const v of ['20px', '16px', '24px']) {
const hits =
tokensSpace.match(new RegExp(`--chat-row-gap:\\s*${v}`, 'g'))?? [];
expect(hits.length, `--chat-row-gap: ${v} 必须恰好一处`).toBe(1);
}
});

it('.row 的 padding-bottom 消费 --chat-row-gap，回退与默认密度同值 20px', () => {
const b = block(rowCss, '.row');
expect(b).not.toBe('');
expect(b).toMatch(/padding-bottom:\s*var\(--chat-row-gap, 20px\)/);
expect(b).not.toMatch(/--chat-row-gap,[^)]*16px/);
});

it('meta 槽 32：margin-top 4（--space-1）+ min-height 28，用户/助手同构', () => {
expect(rowCss).toMatch(
/\.userMeta,\s*\.assistantMeta\s*\{[^}]*margin-top:\s*var\(--space-1, 4px\)/
);
expect(block(rowCss, '.userMeta')).toMatch(/min-height:\s*28px/);
// .assistantMeta 的首个行首同名块是与 .userMeta 的共享块（无 min-height），
    // 须锚定其独立块（display: flex 起）断言 min-height
    expect(rowCss).toMatch(
      /\.assistantMeta\s*\{\s*display:\s*flex;[^}]*min-height:\s*28px/
    );
});

it('负向断言：DEF-13 注释不得再把 16px 写成.row 行距默认值', () => {
expect(listCssRaw).not.toMatch(/\.row padding-bottom: 16px/);
});
});

/* ═══════════════════════════════════════════════════════════════════
* L3 流层
* ═══════════════════════════════════════════════════════════════════ */
describe('L3 流层', () => {
it('流内相邻段盒间隙恒 8：.assistantTimelineStream gap = var(--space-2, 8px)', () => {
const b = block(contentCss, '.assistantTimelineStream');
expect(b).not.toBe('');
expect(b).toMatch(/gap:\s*var\(--space-2, 8px\)/);
});
});

/* ═══════════════════════════════════════════════════════════════════
* L4 段内层
* ═══════════════════════════════════════════════════════════════════ */
describe('L4 段内层', () => {
it('段内相邻 0：.sectionBodyInner /.sectionFadeInner gap: 0', () => {
expect(block(foldCss, '.sectionBodyInner')).toMatch(/gap:\s*0;/);
expect(block(foldCss, '.sectionFadeInner')).toMatch(/gap:\s*0;/);
});

it('组内工具行间 3：--tool-row-gap（tokens-base）', () => {
expect(tokensBase).toMatch(/--tool-row-gap:\s*3px/);
});

it('段内叙述 margin-block 6（--space-1_5），且其末段归零先例仍在', () => {
expect(block(contentCss, '.narrationText')).toMatch(
/margin-block:\s*var\(--space-1_5, 6px\)/
);
expect(contentCss).toMatch(
/\.narrationText :global\(\.md-p:last-child\)\s*\{\s*margin-bottom:\s*0/
);
});

it('思考体纵向 padding 6/6：.reasoningBody padding: 6px 0 6px 12px', () => {
expect(block(reasoningCss, '.reasoningBody')).toMatch(
/padding:\s*6px 0 6px 12px/
);
});
});

/* ═══════════════════════════════════════════════════════════════════
* L5 md 排版层 + 流内段尾归零收口（方向②）
* ═══════════════════════════════════════════════════════════════════ */
describe('L5 md 排版层', () => {
it('chat 变体段后距 0.82em，且.md-p 全局规则仍经该 token 取值（全局不动）', () => {
expect(mdCss).toMatch(
/\[data-md-variant='chat'\]\s*\{[^}]*--md-paragraph-margin-bottom:\s*0\.82em/
);
expect(mdCss).toMatch(
/:is\(p, \.md-p\)\s*\{\s*margin:\s*0 0 var\(--md-paragraph-margin-bottom\)/
);
});

it('正文块间 0.65em：--md-block-gap（tokens-components），由.assistantText 承载、末块归零', () => {
expect(tokensComponents).toMatch(/--md-block-gap:\s*0\.65em/);
expect(rowCss).toMatch(
/\.streamingMarkdownRoot > \.assistantText\s*\{\s*margin-block-end:\s*var\(--md-block-gap\)/
);
expect(rowCss).toMatch(
/\.streamingMarkdownRoot > \.assistantText:last-child\s*\{\s*margin-block-end:\s*0/
);
});

it('方向②：流层正文段尾归零规则在.contentText 作用域内（MessageContent）', () => {
expect(contentCss).toMatch(
/\.contentText :global\(\.md-rendered\) > :global\(\.md-p:last-child\)[\s\S]{0,240}?margin-bottom:\s*0;/
);
});

it('方向②：思考展开体尾部归零规则在.reasoningContent 作用域内（ReasoningRow）', () => {
expect(reasoningCss).toMatch(
/\.reasoningContent :global\(\.md-rendered\) > :global\(\.md-p:last-child\)[\s\S]{0,240}?margin-bottom:\s*0;/
);
});

it('负向断言：归零不得写进排版层全局（markdown-typography 不得出现聊天流表面类名）', () => {
expect(mdCss).not.toMatch(/contentText/);
expect(mdCss).not.toMatch(/reasoningContent/);
});
});
