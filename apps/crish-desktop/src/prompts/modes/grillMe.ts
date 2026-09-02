/**
 * L2 需求澄清与方案对齐模式（/grill-me）指令。
 *
 * 架构定位：按详案 01 归零 2，本指令不拼入 System Prompt；渲染为结构化文本载荷，
 * 经可见注入卡片进入消息时间线（维度一阶段保持文本来源收敛，卡片派发待维度二）。
 */
import { createPromptTemplate } from '../compiler/interpolate';
import type { PromptTemplate } from '../types';

export interface GrillMeParams {
  /** 用户提出的对齐主题 */
  topic: string;
  /** 单轮提问数量上限（缺省 5） */
  maxQuestions?: number;
}

export const GRILL_ME_PROMPT: PromptTemplate<GrillMeParams> =
  createPromptTemplate<GrillMeParams>(
    {
      id: 'mode-grill-me',
      name: '需求澄清与方案对齐指令',
      description: '针对复杂需求展开深入对齐澄清，暂不修改代码',
      layer: 'mode',
      version: '1.0.0',
      defaultLocale: 'zh-CN',
      tags: ['grill-me', 'planning', 'clarification'],
      defaultParams: {
        maxQuestions: 5,
      },
    },
    {
      'zh-CN': `[对齐模式 · 系统指令]
你现在是资深产品与技术架构对齐助手。
针对用户提出的主题「{{topic}}」，你的核心任务是挖掘隐含需求、明确边界与澄清模糊点。

- **执行红线**：本模式下暂不编写代码、不修改文件、不执行破坏性命令；
- **提问约束**：聚焦关键设计决策，一次性提出不超过 {{maxQuestions}} 个具体、可回答的核心问题；
- **待确认后实施**：待用户逐项反馈并确认方案基调后，再引导切换至实施阶段。
---`,
      'en-US': `[Alignment Mode · System Directive]
You are a Lead Product & Technical Architect conducting a requirement alignment session.
Topic: "{{topic}}"

- **Guardrails**: Do NOT write production code or modify files during this phase.
- **Questions Budget**: Pose up to {{maxQuestions}} precise, high-impact architectural/functional questions.
- **Next Step**: Once the user aligns on decisions, summarize the spec and transition to implementation.
---`,
    }
  );
