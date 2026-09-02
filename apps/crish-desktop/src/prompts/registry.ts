/**
 * 提示词集中注册表：维护全量 PromptTemplate 实例，支持按 ID / Layer 检索。
 * 纯前端内存注册表（同步构造，无异步副作用）；不引入运行时编译缓存（归零 4）。
 */
import type { PromptLayer, PromptTemplate } from './types';
import { SYSTEM_CORE_PROMPT } from './core/systemCore';
import { RESPONSE_STYLE_PROMPT } from './core/responseStyles';
import { HOST_ENVIRONMENT_PROMPT } from './environment/hostEnvironment';
import { WORKFLOW_ASSISTANT_PROMPT } from './modes/workflowAssistant';
import { GOAL_MODE_PROMPT } from './modes/goalMode';
import { GRILL_ME_PROMPT } from './modes/grillMe';
import { CODE_REVIEW_PROMPT } from './modes/codeReview';

class PromptRegistryImpl {
  private readonly registry = new Map<string, PromptTemplate<never>>();

  constructor() {
    this.register(SYSTEM_CORE_PROMPT);
    this.register(RESPONSE_STYLE_PROMPT);
    this.register(HOST_ENVIRONMENT_PROMPT);
    this.register(WORKFLOW_ASSISTANT_PROMPT);
    this.register(GOAL_MODE_PROMPT);
    this.register(GRILL_ME_PROMPT);
    this.register(CODE_REVIEW_PROMPT);
  }

  public register(template: PromptTemplate<any>): void {
    this.registry.set(template.meta.id, template as PromptTemplate<never>);
  }

  public get<T extends Record<string, unknown> = Record<string, unknown>>(
    id: string
  ): PromptTemplate<T> | undefined {
    return this.registry.get(id) as PromptTemplate<T> | undefined;
  }

  public listByLayer(layer: PromptLayer): PromptTemplate<never>[] {
    return Array.from(this.registry.values()).filter(
      (t) => t.meta.layer === layer
    );
  }

  public listAll(): PromptTemplate<never>[] {
    return Array.from(this.registry.values());
  }
}

export const PromptRegistry = new PromptRegistryImpl();
