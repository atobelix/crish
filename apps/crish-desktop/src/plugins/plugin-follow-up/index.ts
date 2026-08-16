/**
 * apps/crish-desktop/src/plugins/plugin-follow-up/index.ts
 * 智能后续行动建议引导插件 (DIM-06, RUL-06)。
 * - 会话级隔离 (Session-Scoped Suggestions Cache)
 * - 🚨 子 Agent (Subagent) 100% 物理隔离屏蔽：
 *   若处于子 Agent 会话 (isSubagent === true)，坚决阻断建议生成与 UI 渲染，
 *   彻底消灭 Token 浪费与跨分屏串味。
 *
 * CI Guardrail: Business Logic (Max 400 lines of effective code, UTF-8 无 BOM)
 */

import type { CrishPlugin, PluginContext, PluginManifest } from '../types';

export const FollowUpManifest: PluginManifest = {
  id: '@crish/plugin-follow-up',
  name: 'Follow-Up Action Suggestions',
  version: '1.0.0',
  description:
    '智能后续提问与行动建议插件（会话级隔离，子 Agent 100% 物理隔离屏蔽）',
  category: 'assistant',
  isOfficial: true,
  enabledByDefault: true,
  permissions: ['assistant:suggestions'],
};

export interface FollowUpSuggestionItem {
  id: string;
  label: string;
  prompt: string;
}

export interface FollowUpConfig {
  maxSuggestions?: number;
  autoSuggest?: boolean;
}

export class FollowUpPluginImpl implements CrishPlugin<FollowUpConfig> {
  public readonly manifest = FollowUpManifest;
  private sessionSuggestions = new Map<
    string,
    Map<string, FollowUpSuggestionItem[]>
  >();

  public activate(ctx: PluginContext<FollowUpConfig>): void {
    // 监听会话清理事件
    const handleSessionClosed = (event: Event) => {
      const customEvent = event as CustomEvent<{ sessionId: string }>;
      if (customEvent.detail?.sessionId) {
        this.clearSession(customEvent.detail.sessionId);
      }
    };

    if (typeof window !== 'undefined') {
      ctx.subscriptions.addEventListener(
        window,
        'crish:session:closed',
        handleSessionClosed
      );
    }
  }

  public deactivate(ctx: PluginContext<FollowUpConfig>): void {
    this.sessionSuggestions.clear();
    void ctx.subscriptions.dispose();
  }

  /**
   * 判定并生成后续建议（受子 Agent 严格硬阻断防护）
   */
  public generateSuggestions(params: {
    sessionId: string;
    messageId: string;
    isSubagent?: boolean;
    toolCalls?: Array<{ name: string; status: string; output?: string }>;
    text?: string;
  }): FollowUpSuggestionItem[] {
    // 🚨 第 1 重 & 第 2 重防线：子 Agent 绝不生成任何建议！
    if (params.isSubagent) {
      return [];
    }

    const { sessionId, messageId, toolCalls = [] } = params;
    if (toolCalls.length === 0) return [];

    const suggestions: FollowUpSuggestionItem[] = [];

    const hasError = toolCalls.some((t) => t.status === 'error');
    const hasSuccess = toolCalls.some((t) => t.status === 'success');

    if (hasError) {
      suggestions.push({
        id: 'diagnose-error',
        label: '排查失败原因',
        prompt: '请根据刚才失败的工具输出，分析根因并给出可执行的修复步骤',
      });
      suggestions.push({
        id: 'retry-safe',
        label: '安全重试',
        prompt: '在不扩大破坏面的前提下，重试刚才失败的操作；先说明你会怎么做',
      });
    } else if (hasSuccess) {
      suggestions.push({
        id: 'next-step',
        label: '下一步建议',
        prompt:
          '基于刚才完成的操作，给出 2–3 个最合理的下一步，并直接执行最优先的一项',
      });
      suggestions.push({
        id: 'run-tests',
        label: '验证与测试',
        prompt: '针对刚才改动的范围运行相关测试或类型检查，并总结结果',
      });
    }

    this.setSuggestions(sessionId, messageId, suggestions);
    return suggestions;
  }

  public getSuggestions(
    sessionId: string,
    messageId: string
  ): FollowUpSuggestionItem[] {
    return this.sessionSuggestions.get(sessionId)?.get(messageId) || [];
  }

  public setSuggestions(
    sessionId: string,
    messageId: string,
    items: FollowUpSuggestionItem[]
  ): void {
    if (!this.sessionSuggestions.has(sessionId)) {
      this.sessionSuggestions.set(sessionId, new Map());
    }
    this.sessionSuggestions.get(sessionId)!.set(messageId, items);
  }

  public dismissSuggestions(sessionId: string, messageId: string): void {
    this.sessionSuggestions.get(sessionId)?.delete(messageId);
  }

  public clearSession(sessionId: string): void {
    this.sessionSuggestions.delete(sessionId);
  }
}

export const FollowUpPlugin = new FollowUpPluginImpl();
