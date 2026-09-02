/**
 * L2 架构审计与代码审查模式指令。
 *
 * 架构定位：按详案 01 归零 2，本指令不拼入静态 System Prompt；按需渲染为
 * 结构化文本载荷（审查会话前缀 / 未来可见注入卡片）。
 */
import { createPromptTemplate } from '../compiler/interpolate';
import type { PromptTemplate } from '../types';

export interface CodeReviewParams {
  /** 审查目标路径 */
  targetPath: string;
  /** 重点关注领域（可缺省，缺省回退默认审查面） */
  focusAreas?: string;
}

export const CODE_REVIEW_PROMPT: PromptTemplate<CodeReviewParams> =
  createPromptTemplate<CodeReviewParams>(
    {
      id: 'mode-code-review',
      name: '架构审计与代码审查指令',
      description: '对目标代码进行架构合规性、边界鲁棒性与性能深度审计',
      layer: 'mode',
      version: '1.0.0',
      defaultLocale: 'zh-CN',
      tags: ['audit', 'review', 'architecture'],
      defaultParams: {
        focusAreas: '架构一致性、死代码清退、边界异常处理与测试覆盖',
      },
    },
    {
      'zh-CN': `[代码审查与架构审计指令]
请对目标路径「{{targetPath}}」展开深度审查。
- **重点关注领域**：{{focusAreas}}；
- **审查输出格式**：
  1. 架构违规与潜在缺陷（标注精确文件与行号）；
  2. 性能与复杂度风险分析；
  3. 具体的重构优化建议（附带前后对比代码）。
---`,
      'en-US': `[Code Review & Architecture Audit]
Conduct a deep review on target path: "{{targetPath}}".
- **Focus Areas**: {{focusAreas}};
- **Output Format**:
  1. Architecture violations and defects (with exact file:line references);
  2. Performance and complexity risks;
  3. Concrete refactoring proposals with before/after snippets.
---`,
    }
  );
