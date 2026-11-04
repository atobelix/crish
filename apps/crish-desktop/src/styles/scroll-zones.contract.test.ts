/**
 * DIM-02 修订版契约（HC1）：页面级滚动容器唯一 + 受限内容滚动区白名单。
 *
 * 口径（用户 2026-11-02 裁决）：[data-chat-scroll-container] 是会话内唯一的
 * 【页面级】纵向滚动容器；其内只允许白名单登记的受限滚动区（工具视口 /
 * 组聚合区 / 过程段体 / 代码块 / 思考区 / 独立态 Diff）。治理文件内在白名单
 * 外新增 overflow-y: auto/scroll（或 overflow 简写）一律判契约失败——新增
 * 滚动区必须先修订白名单并在本文件登记理由。新增受限滚动区必须引用
 * 档位 token（--expand-max-h-*），不得新写裸值（高度分档定案）。
 *
 * 区域划分（H1 扩容）：区域一 = 会话容器内（消息流及其叙事/输入区面）；
 * 区域二 = 侧边栏 / 工作区（AgentCard 时间线宿主与文件 Diff 叶面）。
 * 区域二只登记承载受限封顶或重点治理的文件；工作区其余叶面（FilesCard
 * 列表、FileViewerCard 历史体、TerminalCard 主体等 flex 布局填充型滚动）
 * 属「布局约束型」——高度由叶布局几何决定、不适用展开档，不逐文件登记。
 * 已登记文件内的布局填充型滚动区（如 DiffCard 的 .plainScrollParent /
 * .bodyWrap / .flatFileList，max-height: none 或 flex 填充）随文件一并
 * 登记为区集成员，与受限封顶型（.scrollParent 两形态）分开注明。
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');

function readCss(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf-8');
}

type CssRule = { selector: string; body: string };

/** 极简规则抽取：剥注释后按花括号深度走读，@media/@supports 透明穿透，@keyframes 跳过 */
function extractRules(css: string): CssRule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  let i = 0;
  const walk = (endChar: string | null) => {
    let prelude = '';
    while (i < src.length) {
      const ch = src[i];
      if (endChar && ch === endChar) {
        i++;
        return;
      }
      if (ch === '{') {
        const head = prelude.replace(/\s+/g, ' ').trim();
        prelude = '';
        i++;
        if (/^@(media|supports)\b/.test(head)) {
          walk('}');
        } else if (/^@/.test(head)) {
          // @keyframes 等：整块跳过
          let depth = 1;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
        } else {
          let body = '';
          let depth = 1;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') {
              depth--;
              if (depth === 0) {
                i++;
                break;
              }
            }
            if (depth > 0) body += src[i];
            i++;
          }
          if (head) rules.push({ selector: head, body });
        }
      } else if (ch === '}') {
        i++;
        if (endChar) return;
      } else {
        prelude += ch;
        i++;
      }
    }
  };
  walk(null);
  return rules;
}

function isVerticalScrollZone(body: string): boolean {
  return (
    /overflow-y\s*:\s*(auto|scroll)/.test(body) ||
    /overflow\s*:\s*(auto|scroll)/.test(body)
  );
}

/** 选择器比较双边归一化：空白折叠 + 逗号后空格统一，免于书写风格差异假红；后代组合空格保持显著 */
function canon(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

/** 文件 → 允许的纵向滚动区选择器（归一后全等匹配）· 区域一：会话容器内 */
const REGION_SESSION: Record<string, string[]> = {
  'components/chat-message-list/ChatMessageList.module.css': [
    '.list, :global([data-chat-scroll-container])',
  ],
  'components/chat-tool-call/ChatToolCallBlock.module.css': [
    '.toolSectionContent',
    '.toolShellCmdViewport',
  ],
  'components/chat-tool-call/FoldableToolGroup.module.css': ['.groupBodyInner'],
  'components/chat-message/FoldableProcessSection.module.css': [
    '.sectionBodyInner',
  ],
  'components/chat-message-row/ReasoningRow.module.css': ['.reasoningBody'],
  'styles/markdown-typography.css': [
    ':is(.conex-markdown, .md-rendered) .md-code-pre',
  ],
  'components/chat-tool-call/ToolCallDiffPreview.module.css': [
    ".diffCard:not([data-card-variant='embedded']) .diffLinesContainer",
  ],
  // 叙事流（H1）：详情/思考/子代理共用规则、子代理壳、笔记体
  'extensions/conversation-flow/narrative.module.css': [
    '.detail, .thinkingFull, .subagentBody',
    '.subagent',
    '.notebookBody',
  ],
  // 输入区计划步骤列表（H1）：全树唯一真无界缺口收口后登记
  'components/chat-composer/ComposerPlanProgressBar.module.css': [
    '.planStepListInner',
  ],
};

/** 文件 → 允许的纵向滚动区选择器（归一后全等匹配）· 区域二：侧边栏 / 工作区 */
const REGION_WORKSPACE: Record<string, string[]> = {
  // AgentCard：时间线宿主（页级填充）/ 启动列表 / 启动体 / 团队板网格
  'components/agent-card/AgentCard.module.css': [
    '.agentCardBody',
    '.agentLaunchBody',
    '.agentLaunchList',
    '.agentTeamBoardGrid',
  ],
  // 文件 Diff 叶面：.scrollParent 两形态为受限封顶型；其余三区为布局填充型
  'components/diff/DiffCard.module.css': [
    '.scrollParent',
    '.diffPane :global(.scrollParent), .diffPane .scrollParent',
    '.plainScrollParent',
    '.bodyWrap',
    '.flatFileList',
  ],
};

describe('DIM-02 修订契约 · 滚动区白名单', () => {
  it('ChatMessageList 契约注释已修订为「页面级 + 白名单」口径', () => {
    const css = readCss(
      'components/chat-message-list/ChatMessageList.module.css'
    );
    expect(css).toContain('页面级');
    expect(css).toContain('白名单');
  });

  for (const [region, table] of [
    ['区域一·会话容器内', REGION_SESSION],
    ['区域二·侧边栏/工作区', REGION_WORKSPACE],
  ] as const) {
    for (const [rel, allowed] of Object.entries(table)) {
      it(`[${region}] ${rel} 的纵向滚动区恰为白名单登记集`, () => {
        const zones = extractRules(readCss(rel))
          .filter((r) => isVerticalScrollZone(r.body))
          .map((r) => canon(r.selector));
        expect(zones.sort()).toEqual(allowed.map(canon).sort());
      });
    }
  }
});

describe('scroll-fade.css · mask 渐隐（无覆盖层）', () => {
  const css = () => readCss('styles/scroll-fade.css');

  it('四态选择器齐备且走 mask-image', () => {
    const content = css();
    expect(content).toContain('mask-image');
    expect(content).toContain('-webkit-mask-image');
    expect(content).toContain("[data-fade='bottom']");
    expect(content).toContain("[data-fade='top']");
    expect(content).toContain("[data-fade='both']");
    expect(content).toContain('.scroll-fade-inner');
  });

  it('零 background 声明——渐隐只由 mask 承担，不存在覆盖层底色', () => {
    const noComments = css().replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments).not.toMatch(/background\s*:/);
  });
});
