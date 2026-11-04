/**
 * HC1 契约钉（用户 2026-11-02 裁决）：
 * 1) 高度 token 精确值与各滚动宿主的 token 引用——聚合上限 min(280px, 35vh)、
 *    代码 min(240px, 30vh)、思考 min(200px, 25vh)、工具视口 180px 统一封顶；
 * 2) 组内双层滚动降级在位；键值行不再自带嵌套滚动（L-3）；
 * 3) 折叠/流程内容 14px 统一（2026-11-04 用户裁决）；
 * 4) V2 gap A 案：工具行间距 3px 走 token；
 * 5) 行头去重（D-1～D-4）纯函数断言：单权威文本源、动词表单源、
 *    兜底参数禁止原始 JSON（键名 + 类型占位）。
 * 6) 高度分档（H1，用户 2026-11-02 裁决）：档位正典 --expand-max-h-*
 *    （档1 聚合 / 档2 内容 / 档3 嵌套 / 档4 视口出·入）落地，HC1 token
 *    改为指向正典的引用链——思考落档3、单工具出参落档2，其余值不变；
 *    叙事流 --flow-output-max（600px 倒挂源）退役，四面改引档位；
 *    计划步骤列表（全树唯一真无界缺口）落档4·出封顶 + 自滚。
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { MessageToolCall } from '../../../api/sessionTypes';
import {
  toolHumanLabel,
  toolHumanLabelSource,
} from '../../../api/tool-presentation/toolHumanDescriptions';
import {
  extractFallbackParam,
  resolveToolActionAndParam,
  shouldShowHumanLabel,
} from '../toolHeaderPresentation';

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

function ruleBody(css: string, selectorRe: RegExp): string {
  const m = css.match(new RegExp(selectorRe.source + '\\s*\\{([^}]*)\\}'));
  return m?.[1] ?? '';
}

/** 锚定行首的独立规则块（避免误命中 `.toolRow.isRunning .toolRowSummary` 等复合规则） */
function standaloneBody(css: string, cls: string): string {
  const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`^${esc}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
}

describe('HC1 · 高度 token 与宿主引用', () => {
  const tokens = read('styles/tokens-base.css');

  it('档位正典精确值（高度分档定案 · 2026-11-04 减半收敛）', () => {
    expect(tokens).toContain('--expand-max-h-aggregate: min(280px, 35vh);');
    expect(tokens).toContain('--expand-max-h-content: min(240px, 30vh);');
    expect(tokens).toContain('--expand-max-h-nested: min(200px, 25vh);');
    expect(tokens).toContain('--expand-max-h-viewport: 180px;');
    expect(tokens).toContain('--expand-max-h-viewport-sm: 180px;');
    expect(tokens).toContain('--tool-fade-size: 40px;');
    expect(tokens).toContain('--tool-fade-size-sm: 28px;');
    expect(tokens).toContain('--tool-fade-size-lg: 52px;');
    expect(tokens).toContain('--tool-fade-feather: 6px;');
    expect(tokens).toContain('--tool-row-gap: 3px;');
  });

  it('HC1 token 引用链（归档后实际值由档位正典决定）', () => {
    expect(tokens).toContain(
      '--tool-viewport-input: var(--expand-max-h-viewport-sm);'
    );
    expect(tokens).toContain(
      '--tool-viewport-output: var(--expand-max-h-viewport);'
    );
    expect(tokens).toContain(
      '--tool-viewport-output-single: var(--expand-max-h-viewport);'
    );
    expect(tokens).toContain(
      '--tool-aggregate-max-h: var(--expand-max-h-aggregate);'
    );
    expect(tokens).toContain(
      '--code-block-max-h: var(--expand-max-h-content);'
    );
    expect(tokens).toContain('--reasoning-max-h: var(--expand-max-h-nested);');
    // 旧裸值不得以 HC1 token 定义形态回潮
    expect(tokens).not.toContain('--tool-viewport-output-single: 520px;');
    expect(tokens).not.toContain('--reasoning-max-h: min(480px, 50vh);');
  });

  it('单工具视口改走 token 且数值未被误改（CSS 中不再有裸数值声明）', () => {
    const css = read('components/chat-tool-call/ChatToolCallBlock.module.css');
    expect(css).toContain('max-height: var(--tool-viewport-input');
    expect(css).toContain('max-height: var(--tool-viewport-output');
    expect(css).toContain('max-height: var(--tool-viewport-output-single');
    expect(css).not.toMatch(/max-height:\s*180px/);
    expect(css).not.toMatch(/max-height:\s*380px/);
    expect(css).not.toMatch(/max-height:\s*520px/);
  });

  it('组聚合区封顶 = 聚合 token + 内部滚动', () => {
    const css = read('components/chat-tool-call/FoldableToolGroup.module.css');
    const body = ruleBody(css, /\.groupBodyInner/);
    expect(body).toContain('max-height: var(--tool-aggregate-max-h');
    expect(body).toContain('overflow-y: auto');
  });

  it('过程段体同封顶，且含真实工具组时让位组滚动层（:has 豁免）', () => {
    const css = read(
      'components/chat-message/FoldableProcessSection.module.css'
    );
    const body = ruleBody(css, /\.sectionBodyInner/);
    expect(body).toContain('max-height: var(--tool-aggregate-max-h');
    expect(body).toContain('overflow-y: auto');
    expect(css).toContain(':has(');
    expect(css).toContain("[data-testid='foldable-tool-group']");
    expect(css).toContain("[data-single-tool='true']");
  });

  it('代码块封顶 = 代码 token + 内部滚动', () => {
    const css = read('styles/markdown-typography.css');
    const body = ruleBody(
      css,
      /:is\(\.conex-markdown, \.md-rendered\) \.md-code-pre/
    );
    expect(body).toContain('max-height: var(--code-block-max-h');
    expect(body).toContain('overflow-y: auto');
  });

  it('思考正文封顶 = 思考 token + 内部滚动', () => {
    const css = read('components/chat-message-row/ReasoningRow.module.css');
    const body = ruleBody(css, /\.reasoningBody/);
    expect(body).toContain('max-height: var(--reasoning-max-h');
    expect(body).toContain('overflow-y: auto');
  });

  it('组内视口高度封顶受控（2026-11-04 用户裁决）：纠正高度暴走，禁止取消限高', () => {
    const css = read('components/chat-tool-call/ChatToolCallBlock.module.css');
    expect(css).not.toMatch(
      /:global\(\.tool-group-scroll-host\)\s+\.toolSectionContent\s*\{[^}]*max-height:\s*none/
    );
  });

  it('键值行不再自带嵌套滚动（L-3），长值随外层视口滚动', () => {
    const css = read('components/chat-tool-call/ChatToolCallBlock.module.css');
    const body = ruleBody(css, /\.toolValPre/);
    expect(body).not.toContain('overflow');
    expect(body).not.toContain('max-height');
  });

  it('独立态 Diff 封口走单卡输出 token，嵌入变体除外', () => {
    const css = read(
      'components/chat-tool-call/ToolCallDiffPreview.module.css'
    );
    const body = ruleBody(
      css,
      /\.diffCard:not\(\[data-card-variant='embedded'\]\) \.diffLinesContainer/
    );
    expect(body).toContain('max-height: var(--tool-viewport-output-single');
    expect(body).toContain('overflow-y: auto');
  });

  it('代码块渐隐选择器含后代组合（防 :is(...).md-code-pre 同元素误写回归）', () => {
    const css = read('styles/scroll-fade.css');
    expect(css).toContain(
      ":is(.conex-markdown, .md-rendered) .md-code-pre[data-fade='bottom'] > code"
    );
  });
});

describe('HC1 · 14px 统一排版与 V2 gap（2026-11-04 用户裁决）', () => {
  it('工具行文本族 14px', () => {
    const css = read('components/chat-tool-call/ChatToolCallBlock.module.css');
    for (const cls of [
      '.toolRowHead',
      '.toolRowSummary',
      '.toolActionText',
      '.toolParamText',
    ]) {
      expect(standaloneBody(css, cls)).toContain('font-size: 14px');
    }
  });

  it('组头/段头/思考行 14px', () => {
    const group = read(
      'components/chat-tool-call/FoldableToolGroup.module.css'
    );
    expect(ruleBody(group, /\.groupHeader/)).toContain('font-size: 14px');
    const section = read(
      'components/chat-message/FoldableProcessSection.module.css'
    );
    expect(ruleBody(section, /\.summaryLabel/)).toContain('font-size: 14px');
    const reasoning = read(
      'components/chat-message-row/ReasoningRow.module.css'
    );
    expect(ruleBody(reasoning, /\.reasoningRow/)).toContain('font-size: 14px');
    expect(ruleBody(reasoning, /\.reasoningContent/)).toContain(
      'font-size: 14px'
    );
  });

  it('工具行间距走 gap token（A 案 2–4px 内）', () => {
    const css = read('components/chat-tool-call/ChatToolCallBlock.module.css');
    expect(ruleBody(css, /\.toolStack/)).toContain('gap: var(--tool-row-gap');
  });
});

describe('HC1 · TSX 接线（F1 组件化：组件契约 + 宿主存在断言）', () => {
  // 防线迁移（F1）：「CSS 先行、接线缺席」（C1 审计 D-1 教训）的复发面
  // 从五宿主收敛为一处组件——逐宿主查接线改为「组件自身渲染契约 +
  // 各宿主确实用了组件的存在断言 + 宿主未绕开组件手写内层/状态机」。
  it('ScrollFadeRegion 组件契约：状态机经 useScrollFade 挂载、内层必带 scroll-fade-inner', () => {
    const comp = read('components/ui/ScrollFadeRegion/ScrollFadeRegion.tsx');
    expect(comp).toContain("from './useScrollFade'");
    expect(comp).toContain('useScrollFade(ownHostRef, active)');
    expect(comp).toContain('scroll-fade-inner');
    expect(comp).toContain('data-slot="scroll-fade-region"');
  });

  it('四 React 宿主经 ScrollFadeRegion 接入（组体 host 类 / 双 Pane / 思考体）', () => {
    const group = read('components/chat-tool-call/FoldableToolGroup.tsx');
    expect(group).toContain('ScrollFadeRegion');
    expect(group).toContain('tool-group-scroll-host');
    expect(group).toContain('active={isExpanded}');
    const input = read('components/chat-tool-call/ToolCallInputPane.tsx');
    expect(input).toContain('ScrollFadeRegion');
    expect(input).toContain('innerAs="pre"');
    const output = read('components/chat-tool-call/ToolCallOutputPane.tsx');
    expect(output).toContain('ScrollFadeRegion');
    expect(output).toContain('onInnerAnimationEnd={reveal.handleFadeEnd}');
    const reasoning = read('components/chat-message-row/ReasoningRow.tsx');
    expect(reasoning).toContain('ScrollFadeRegion');
    expect(reasoning).toContain('active={isExpanded}');
  });

  it('段体为渐隐新宿主（F1 第一优先）：FoldableProcessSection 经组件接入', () => {
    const section = read('components/chat-message/FoldableProcessSection.tsx');
    expect(section).toContain('ScrollFadeRegion');
    expect(section).toContain('sectionFadeInner');
  });

  it('代码块保留命令式成员（形态 C）：MarkdownSurface 仍经 bindScrollFadesIn 绑定', () => {
    const surface = read('components/markdown/MarkdownSurface.tsx');
    expect(surface).toContain('bindScrollFadesIn');
  });

  it('限高视口补齐接入（E7 渐隐强化）：DiffCard、审批卡命令视口、计划步骤列表经 ScrollFadeRegion 接入', () => {
    const diff = read('components/chat-tool-call/ToolCallDiffPreview.tsx');
    expect(diff).toContain('ScrollFadeRegion');
    expect(diff).toContain('diffFadeInner');
    const approval = read('components/agent-card/ApprovalAskCard.tsx');
    expect(approval).toContain('ScrollFadeRegion');
    expect(approval).toContain('fadeSize="sm"');
    const plan = read('components/chat-composer/ComposerPlanProgressBar.tsx');
    expect(plan).toContain('ScrollFadeRegion');
    expect(plan).toContain('active={isExpanded}');
  });

  it('负向断言：已迁移宿主不得绕开组件直用状态机或手写 fade 内层', () => {
    for (const rel of [
      'components/chat-tool-call/FoldableToolGroup.tsx',
      'components/chat-tool-call/ToolCallInputPane.tsx',
      'components/chat-tool-call/ToolCallOutputPane.tsx',
      'components/chat-message-row/ReasoningRow.tsx',
      'components/chat-message/FoldableProcessSection.tsx',
      'components/chat-tool-call/ToolCallDiffPreview.tsx',
      'components/agent-card/ApprovalAskCard.tsx',
      'components/chat-composer/ComposerPlanProgressBar.tsx',
    ]) {
      const tsx = read(rel);
      expect(tsx).not.toContain('useScrollFade');
      expect(tsx).not.toContain('scroll-fade-inner');
    }
  });
});

describe('高度分档 · 接线级断言（H1）', () => {
  it('单工具组归档口径：无独立组体，内容封顶由单工具出参（档2）承担', () => {
    // 盘面实情（与普查文档 §3.5 的字面改法有别，协调裁定后按实情钉）：
    // data-single-tool 只出现在 FoldableToolGroup 的非折叠分支，该分支
    // 直挂 ChatToolStack、没有 .groupBodyInner——给它写降档规则只会得到
    // 一条永不命中的死规则。单工具轮次的内容封顶实际由行内视口承担：
    // 单工具出参 --tool-viewport-output-single 已引用链落档2（见上方
    // 引用链断言），独立态 Diff 同 token 消费（见「独立态 Diff 封口」断言）；
    // 段体信封 560 为档1 的正当角色（消息流最外层），不在此降档。
    const tsx = read('components/chat-tool-call/FoldableToolGroup.tsx');
    expect(tsx).toContain('data-single-tool="true"');
    const css = read('components/chat-tool-call/FoldableToolGroup.module.css');
    expect(css).not.toMatch(/\[data-single-tool/);
  });

  it('叙事流归档：--flow-output-max 退役，思考档3 / 子代理·详情档2', () => {
    const css = read('extensions/conversation-flow/narrative.module.css');
    expect(css).not.toContain('--flow-output-max');
    const shared = ruleBody(
      css,
      /\.detail,\s*\.thinkingFull,\s*\.subagentBody/
    );
    expect(shared).toContain('max-height: var(--expand-max-h-content)');
    expect(shared).toContain('overflow: auto');
    const thinking = ruleBody(css, /\.thinkingFull/);
    expect(thinking).toContain('max-height: var(--expand-max-h-nested)');
    const subagent = ruleBody(css, /\.subagent/);
    expect(subagent).toContain('max-height: var(--expand-max-h-content)');
    // 内联限高写者（FLOW_OUTPUT_STYLE）已删除：高度只由 CSS 档位承担
    const thinkingTsx = read('extensions/conversation-flow/ThinkingBlock.tsx');
    expect(thinkingTsx).not.toContain('FLOW_OUTPUT_STYLE');
    const actionTsx = read('extensions/conversation-flow/ActionRow.tsx');
    expect(actionTsx).not.toContain('FLOW_OUTPUT_STYLE');
    expect(
      fs.existsSync(
        path.join(SRC, 'extensions/conversation-flow/flowOutputStyle.ts')
      )
    ).toBe(false);
  });

  it('叙事笔记：卡落档3，体不再自带独立上限（flex 填充滚动）', () => {
    const css = read('extensions/conversation-flow/narrative.module.css');
    expect(ruleBody(css, /\.notebook/)).toContain(
      'max-height: var(--expand-max-h-nested)'
    );
    const body = ruleBody(css, /\.notebookBody/);
    expect(body).not.toContain('max-height');
    expect(body).toContain('overflow: auto');
  });

  it('计划步骤列表封顶在位（档4·出 + 自滚）', () => {
    const css = read(
      'components/chat-composer/ComposerPlanProgressBar.module.css'
    );
    const body = ruleBody(css, /\.planStepListInner/);
    expect(body).toContain('max-height: var(--expand-max-h-viewport)');
    expect(body).toContain('overflow-y: auto');
  });
});

// 动词口径（2026-11-02 整波收口合并裁定）：词干以 HC1 为准（grep=搜索、
// glob=查找、read=读取、list_dir=列出目录），成功时态形以 R8 为准——
// 故 success 状态的 actionText 断在完成式（已读取/已列出目录/已搜索/
// 已查找），error 等其余状态断在词干。toolHumanLabel（入参派生标签）
// 不分时态，恒为词干形。
describe('HC1 · 行头去重（D-1～D-4）', () => {
  const tc = (partial: Record<string, unknown>) =>
    partial as unknown as MessageToolCall;

  it('list_dir：入参派生标签不与 action+param 并列，「列出目录 src」只出现一遍', () => {
    const call = tc({
      name: 'list_dir',
      arguments: JSON.stringify({ DirectoryPath: 'src' }),
      status: 'success',
    });
    const human = toolHumanLabel(call);
    expect(human).toBe('列出目录 src');
    expect(toolHumanLabelSource(call)).toBe('args');
    const r = resolveToolActionAndParam(call, human);
    expect(r.actionText).toBe('已列出目录');
    expect(r.paramText).toBe('src');
    expect(
      shouldShowHumanLabel({
        human,
        humanSource: 'args',
        actionText: r.actionText,
        paramText: r.paramText,
      })
    ).toBe(false);
  });

  it('explanation 与 action+param 构成包含关系时不并列；无关时并列', () => {
    expect(
      shouldShowHumanLabel({
        human: '读取 useMarkdownRenderer.ts',
        humanSource: 'explanation',
        actionText: '读取',
        paramText: 'useMarkdownRenderer.ts',
      })
    ).toBe(false);
    expect(
      shouldShowHumanLabel({
        human: '查看当前目录',
        humanSource: 'explanation',
        actionText: '列出目录',
        paramText: 'src',
      })
    ).toBe(true);
  });

  it('read 动词单源：入参派生标签统一为「读取」', () => {
    const call = tc({
      name: 'read_file',
      arguments: JSON.stringify({ path: 'src/useMarkdownRenderer.ts' }),
      status: 'success',
    });
    expect(toolHumanLabel(call)).toBe('读取 useMarkdownRenderer.ts');
    const r = resolveToolActionAndParam(call, toolHumanLabel(call));
    expect(r.actionText).toBe('已读取');
  });

  it('grep 动作词中文化为「搜索」，查询词只以参数出现一遍', () => {
    const call = tc({
      name: 'grep_search',
      arguments: JSON.stringify({ query: 'autoScroll' }),
      status: 'success',
    });
    const r = resolveToolActionAndParam(call, toolHumanLabel(call));
    expect(r.actionText).toBe('已搜索');
    expect(r.paramText).toBe('"autoScroll"');
    // 失败态分支同口径
    const err = resolveToolActionAndParam(
      tc({
        name: 'grep_search',
        arguments: JSON.stringify({ query: 'autoScroll' }),
        status: 'error',
      }),
      ''
    );
    expect(err.actionText).toBe('搜索');
  });

  it('glob 动作词中文化为「查找」', () => {
    const call = tc({
      name: 'glob',
      arguments: JSON.stringify({ pattern: 'src/**/*.ts' }),
      status: 'success',
    });
    const r = resolveToolActionAndParam(call, toolHumanLabel(call));
    expect(r.actionText).toBe('已查找');
  });

  it('extractFallbackParam：对象/数组只给类型占位，禁止原始 JSON 进标签（D-4）', () => {
    const out = extractFallbackParam(
      'run_subagent',
      JSON.stringify({
        tasks: [{ capabilityMode: 'a' }, { capabilityMode: 'b' }],
      })
    );
    expect(out).toBe('tasks: [数组 ×2]');
    expect(out).not.toContain('[{');
    const obj = extractFallbackParam(
      'some_tool',
      JSON.stringify({ config: { a: 1, b: 2, c: 3 } })
    );
    expect(obj).toBe('config: {对象 ×3}');
  });

  it('subagent 行头参数走占位口径，不倾倒 tasks JSON', () => {
    const call = tc({
      name: 'run_subagent',
      arguments: JSON.stringify({ tasks: [{ prompt: 'x' }, { prompt: 'y' }] }),
      status: 'success',
    });
    const r = resolveToolActionAndParam(call, toolHumanLabel(call));
    expect(r.paramText).toBe('tasks: [数组 ×2]');
    expect(r.paramText).not.toContain('[{');
  });
});

describe('T1 · 行头链接正典（D1–D5）与展开体微整（D7）+ 骑乘项', () => {
  const css = read('components/chat-tool-call/ChatToolCallBlock.module.css');
  const header = read('components/chat-tool-call/ToolCallHeader.tsx');

  /** 取同名选择器的最后一个规则块（.diffStatsBtn 有共享组规则在前） */
  function lastRuleBody(cssText: string, selector: string): string {
    const idx = cssText.lastIndexOf(selector + ' {');
    if (idx < 0) return '';
    const open = cssText.indexOf('{', idx);
    const close = cssText.indexOf('}', open);
    return cssText.slice(open + 1, close);
  }

  it('D2（复裁）：.toolPathLink 着链接色，hover 呈现虚线下划线与文字色——无背景、无 Button 叠加层', () => {
    const base = standaloneBody(css, '.toolPathLink');
    expect(base).toContain('color: var(--color-link)');
    expect(base).toContain('background: transparent');
    expect(base).toContain('transition:');
    // Button hover 底色走 ::before 叠加层：必须把叠加层变量归零才真正无背景
    expect(base).toContain('--btn-hover-overlay: transparent');
    expect(base).toContain('--btn-active-overlay: transparent');
    const hover = ruleBody(css, /\.toolPathLink:hover/);
    expect(hover).toContain('color: var(--color-link-hover)');
    expect(hover).toContain('background: transparent');
    expect(hover).toContain('text-decoration: underline dashed');
    expect(hover).not.toContain('--state-hover');
  });

  it('D1：行级 hover 不再改写链接颜色（链接身份不随行状态变）', () => {
    expect(css).not.toContain('.toolRowHead:hover .toolPathLink');
  });

  it('D3（复裁）：链接色只属于可点击路径——不可点击参数不着链接色，CSS 类与 TSX 接线均已移除', () => {
    expect(css).not.toContain('toolParamPath');
    expect(header).not.toContain('toolParamPath');
    expect(standaloneBody(css, '.toolParamText')).not.toContain('--color-link');
    // 可点击分支保持原接线（Button + onOpenPath）
    expect(header).toContain('styles.toolPathLink');
  });

  it('D5（复裁）：diff 统计无背景 hover（含 Button 叠加层归零），hover 只让语义色向正文色加深', () => {
    const btn = lastRuleBody(css, '.diffStatsBtn');
    expect(btn).toContain('padding: 0;');
    expect(btn).toContain('border-radius: 0');
    expect(btn).toContain('--btn-hover-overlay: transparent');
    expect(btn).toContain('--btn-active-overlay: transparent');
    expect(btn).not.toContain('background: var(--state-hover)');
    const hover = ruleBody(css, /\.diffStatsBtn:hover/);
    expect(hover).toContain('background: transparent');
    expect(hover).not.toContain('--state-hover');
    const add = ruleBody(css, /\.diffStatsBtn:hover \.diffStatsAdd/);
    expect(add).toContain('var(--diff-add-fg)');
    expect(add).not.toContain('text-decoration');
    const del = ruleBody(css, /\.diffStatsBtn:hover \.diffStatsDel/);
    expect(del).toContain('var(--diff-del-fg)');
    expect(del).not.toContain('text-decoration');
    // 全文件负向：diff 统计按钮不得再出现背景型 hover
    expect(css).not.toMatch(/\.diffStatsBtn:hover\s*\{[^}]*--state-hover/);
  });
  it('D7：展开区横向内边距 18px 对齐行头基线；结果/检索行高单轨 1.5', () => {
    expect(standaloneBody(css, '.toolSection')).toContain(
      'padding: 4px 18px 6px'
    );
    expect(standaloneBody(css, '.toolResultPre')).toContain('line-height: 1.5');
    expect(standaloneBody(css, '.grepMatchList')).toContain('line-height: 1.5');
    expect(css).not.toMatch(/line-height:\s*1\.45/);
  });

  it('H1 骑乘：单卡出参兜底走引用链，520px 字面兜底退场', () => {
    expect(css).not.toContain('520px');
    expect(css).toContain(
      'max-height: var(--tool-viewport-output-single, var(--expand-max-h-content))'
    );
  });

  it('X2 骑乘：本文件 transition all 写法清零，区头动作钮显式列属性', () => {
    expect(css).not.toContain('transition: all');
    const btn = standaloneBody(css, '.toolSectionActionBtn');
    expect(btn).toContain('background-color');
    expect(btn).toContain('border-color');
  });
});
