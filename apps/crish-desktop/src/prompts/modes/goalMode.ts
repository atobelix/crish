/**
 * L2 长期目标推进模式（/goal）指令。
 *
 * 架构定位：GOAL_MODE_PROMPT.render() 产物**严禁回拼进 System Prompt**。
 * 维度一阶段仅替换文本来源、维持既有消费路径（goalmode 前缀文本）不变；
 * 维度二交付 ContextInjectionDispatcher 后切换为 kind: 'runtime_steering' 可见卡片派发。
 */
import { createPromptTemplate } from '../compiler/interpolate';
import type { PromptTemplate } from '../types';

export interface GoalModeParams {
  /** 核心目标文本 */
  goal: string;
  /** 当前轮次（1 起；第 N 轮） */
  currentRound: number;
  /** 自动续写轮次上限 */
  maxRounds: number;
  /** 未完成任务清单 Markdown block（可缺省） */
  openTasksBlock?: string;
}

export const GOAL_MODE_PROMPT: PromptTemplate<GoalModeParams> =
  createPromptTemplate<GoalModeParams>(
    {
      id: 'mode-goal-orchestrator',
      name: '长期目标推进模式指令',
      description: '驱动 Agent 进行多轮自主任务清单维护与阶段自检直至目标达成',
      layer: 'mode',
      version: '1.2.0',
      defaultLocale: 'zh-CN',
      tags: ['goal', 'autonomous', 'multi-turn'],
    },
    {
      'zh-CN': `[目标模式 · 系统指令]
你正在自主执行一项长期工程目标。请持续推进直至目标实质完成，并在每轮结束前自检进度。

- **核心目标**：{{goal}}
- **当前轮次**：第 {{currentRound}} 轮（自动续写上限 {{maxRounds}} 轮，请在预算内高效收敛）
- **推进纪律**：
  1. 保持工作连续性，不要半途停下或只列计划而不执行工具；
  2. 在每次回复末尾维护 Markdown 任务清单（\`- [ ]\` 未完成 / \`- [x]\` 已完成）；
  3. 当所有子任务均已完成且通过验证时，在最终回复中明确写出 \`DONE\` 或「目标已完成」。

{{openTasksBlock}}
---`,
      'en-US': `[Goal Mode · System Directive]
You are autonomously executing a long-running project goal. Proceed steadily until substantial completion.

- **Primary Goal**: {{goal}}
- **Current Iteration**: Round {{currentRound}} of {{maxRounds}}
- **Execution Guidelines**:
  1. Maintain continuous execution. Do not stop midway with only recommendations; take concrete tool actions.
  2. Maintain a Markdown task checklist (\`- [ ]\` open / \`- [x]\` done) in each round.
  3. When fully complete and verified, emit \`DONE\` or "Goal Completed" clearly at the end.

{{openTasksBlock}}
---`,
    }
  );
