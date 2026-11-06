/**
* apps/crish-desktop/src/components/chat-message-row/__tests__/reasoningSummaryAutospace.contract.test.ts
*
* 2026-11-06 A2 的自动化固化。
*
* 背景：全局 text-autospace 规则（styles/markdown-typography.css）只作用于
* `:is(.conex-markdown,.md-rendered)` 作用域；思考摘要（ReasoningRow 的
*.summaryText，纯文本渲染、无 markdown 容器祖先）不在覆盖内——live 实测
* computed text-autospace 为 no-autospace，而展开体（.md-rendered）为
* normal。故.summaryText 必须自带 text-autospace: normal 声明，使中英 /
* 中数接缝（如「root我先列出根目录」）在渲染层自动留间。
*
* 纪律：只处理渲染层，绝不动模型原文（extractFirstLine 取行逻辑不在此列）。
* 本文件只做源码级断言，不渲染组件——声明被删/改回去时 CI 立即红。
*/

import { readFileSync} from 'node:fs';
import { resolve} from 'node:path';
import { describe, expect, it} from 'vitest';

/** 读取 CSS 并剥离注释（注释内的文本不得被误判为真实声明） */
function readCss(...segments: string[]): string {
const raw = readFileSync(resolve(...segments), 'utf8');
return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 提取行首平铺选择器的声明块；未命中返回空串 */
function flatBlock(css: string, selector: string): string {
const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const m = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'));
return m? m[1]: '';
}

describe('思考摘要 autospace 覆盖契约', () => {
it('.summaryText 自带 text-autospace: normal（全局规则覆盖不到摘要作用域）', () => {
const css = readCss(__dirname, '..', 'ReasoningRow.module.css');
const block = flatBlock(css, '.summaryText');
expect(block).not.toBe('');
expect(block).toMatch(/text-autospace:\s*normal\s*;/);
});
});
