/**
 * L0 静态核心系统基座（会话内绝对不可变）。
 *
 * 身份真理源裁决：本项目前端不存在硬编码 AI 身份文本——基座 prompt 来自用户配置
 * （provider profile / options.systemPrompt），Agent 身份与能力由 Rust 侧
 * engine_build.rs M1 ContextInjector 冻结契约承载。本模板职责 = **透传用户基座
 * （{{customSystemPrompt}}，置顶以命中缓存前缀）+ 叠加本项目工程纪律**，
 * 严禁虚构/照抄任何外部产品身份声明。
 */
import { createPromptTemplate } from '../compiler/interpolate';
import type { PromptTemplate } from '../types';

export type SystemCoreParams = {
  /** 用户配置的基础系统提示词（provider profile / options.systemPrompt），本会话内不变 */
  customSystemPrompt?: string;
};

export const SYSTEM_CORE_PROMPT: PromptTemplate<SystemCoreParams> =
  createPromptTemplate(
    {
      id: 'core-system-base',
      name: '基础系统核心基座',
      description: '透传用户基座提示词并叠加本工程纪律（会话内绝对不可变）',
      layer: 'core',
      version: '1.0.0',
      defaultLocale: 'zh-CN',
      tags: ['core', 'base', 'system'],
    },
    {
      'zh-CN': `{{customSystemPrompt}}

# 通用协作与代码纪律（Conex / Crish 工程基线）
1. **中文注释与编码**：所有源码注释、文档及回答必须使用中文，文件严格使用 UTF-8 无 BOM 编码；
2. **精确编辑优先**：优先使用局部精确编辑工具，严格包含上下文行，禁止随意全文件覆盖；
3. **反退避原则**：严禁自行简化需求或降级为 MVP；遇到不确定性必须设计验证用例；
4. **门禁与测试保护**：绝对禁止使用 --no-verify 绕过校验；修复代码后必须运行对应测试验证；
5. **架构收敛**：杜绝打补丁与魔术数字补偿，追求单一真理源（SSOT）。`,
      'en-US': `{{customSystemPrompt}}

# General Coding Discipline (Conex / Crish)
1. **File Encoding & Comments**: Write concise, clean code with UTF-8 encoding (no BOM);
2. **Precise Edits**: Favor localized, exact replacements with contextual lines over full-file overwrites;
3. **No Retreat Principle**: Never downgrade user requirements or drop features unilaterally;
4. **Testing Assets**: Never use --no-verify to bypass hooks; ensure unit and regression tests pass;
5. **Architectural Convergence**: Avoid ad-hoc patches; maintain a Single Source of Truth (SSOT).`,
    }
  );
