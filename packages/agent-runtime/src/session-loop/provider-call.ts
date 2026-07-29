/**
 * ProviderCallCoordinator — Provider 调用协调器
 *
 * 从 AgentSessionLoop 提取，负责 Provider 调用构建、错误处理与 length recovery。
 */

import type { AgentMessage } from '@crish/shared-types';
import type { ProviderStreamContractEvent } from '../provider-stream-contract';
import type { ConversationEngine, ProviderCallGateway, ProviderResponseConsumer } from '../runtime-components';
import type { AgentProvider, AgentTool } from '../types';
import type { ContextManager } from '../runtime-components/context-manager';
import { TokenLedger } from '../token-ledger';
import { resolveProviderFamilyFromProviderId } from './types';

export type LengthAction =
  | { type: 'escalated'; nudgeText: string }
  | { type: 'finish' };

export class ProviderCallCoordinator {
  readonly providerConsumer: ProviderResponseConsumer;

  providerTransientRetries = 0;
  static readonly MAX_PROVIDER_TRANSIENT_RETRIES = 3;
  payloadRecoveryRetries = 0;
  lengthMaxTokensEscalationCount = 0;
  lengthContinueNudgeCount = 0;
  maxTokensOverride: number | undefined;

  private static readonly LENGTH_BASE_MAX_TOKENS = 8192;
  private static readonly LENGTH_MAX_TOKENS_CAP = 32_768;
  private static readonly MAX_LENGTH_MAX_TOKENS_ESCALATIONS = 2;

  lastPromptAssembly: import('../prompt-assembly').PromptAssemblyMetadata | undefined;

  constructor(providerConsumer: ProviderResponseConsumer) {
    this.providerConsumer = providerConsumer;
  }

  async buildProviderCall(
    conversation: ConversationEngine,
    contextManager: ContextManager,
    options: { systemPrompt?: string; provider: AgentProvider; cwd: string; maxOutputTokens?: number },
    tools: AgentTool[],
    sessionId: string,
    signal: AbortSignal,
    providerGateway: ProviderCallGateway,
  ): Promise<AsyncIterable<ProviderStreamContractEvent>> {
    const messages = conversation.getMessagesMutable();
    const providerSystemPrompt = contextManager.projectSystemPrompt(options.systemPrompt);
    const providerMessages = contextManager.projectForProvider(messages);
    const promptContext = contextManager.projectPromptContext(options);
    const { assemblePromptForProvider } = await import('../prompt-assembly');
    const promptAssembly = assemblePromptForProvider({
      providerFamily: resolveProviderFamilyFromProviderId(options.provider.id),
      ...(providerSystemPrompt !== undefined ? { systemPrompt: providerSystemPrompt } : {}),
      messages: providerMessages,
      tools,
      ...(Array.isArray(promptContext.stableContext) ? { stableContext: promptContext.stableContext } : {}),
      ...(Array.isArray(promptContext.volatileContext) ? { volatileContext: promptContext.volatileContext } : {}),
    });

    this.lastPromptAssembly = promptAssembly.metadata;

    const maxTokens = this.resolveRequestMaxTokens(options);
    const providerRequest = {
      sessionId,
      cwd: options.cwd,
      ...(promptAssembly.payload.systemPrompt !== undefined ? { systemPrompt: promptAssembly.payload.systemPrompt } : {}),
      messages: promptAssembly.payload.messages,
      tools: promptAssembly.payload.tools,
      promptAssembly: promptAssembly.metadata,
      signal,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };

    return providerGateway.call(options.provider, providerRequest);
  }

  recordTokenUsage(msg: AgentMessage | undefined, turnIndex: number, ledger: TokenLedger, providerId: string): void {
    const usage = msg?.metadata?.usage as { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } | undefined;
    if (!usage) return;
    ledger.recordFinal({
      turnIndex, inputTokens: usage.promptTokens ?? 0, outputTokens: usage.completionTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0, costUsd: 0, model: '', provider: providerId, timestamp: Date.now(),
    });
  }

  handleLengthFinishReason(msg: AgentMessage, steeringCoordinator: { resetSteeringCount: () => void }): LengthAction {
    if (msg.metadata?.stopReason !== 'length') {
      this.lengthMaxTokensEscalationCount = 0;
      return { type: 'finish' };
    }
    const escalated = this.tryEscalateMaxTokensForLengthRecovery();
    if (escalated) {
      steeringCoordinator.resetSteeringCount();
      return { type: 'escalated', nudgeText: 'Previous assistant output was truncated by the model length limit. Continue exactly from where you left off; do not repeat earlier text unless needed for continuity. Do not call tools unless necessary.' };
    }
    return { type: 'finish' };
  }

  private resolveRequestMaxTokens(options: { maxOutputTokens?: number }): number | undefined {
    if (this.maxTokensOverride !== undefined && Number.isFinite(this.maxTokensOverride) && this.maxTokensOverride > 0) return Math.floor(this.maxTokensOverride);
    if (typeof options.maxOutputTokens === 'number' && Number.isFinite(options.maxOutputTokens) && options.maxOutputTokens > 0) return Math.floor(options.maxOutputTokens);
    return undefined;
  }

  private tryEscalateMaxTokensForLengthRecovery(): boolean {
    if (this.lengthMaxTokensEscalationCount >= ProviderCallCoordinator.MAX_LENGTH_MAX_TOKENS_ESCALATIONS) return false;
    const current = this.maxTokensOverride ?? ProviderCallCoordinator.LENGTH_BASE_MAX_TOKENS;
    if (current >= ProviderCallCoordinator.LENGTH_MAX_TOKENS_CAP) return false;
    const next = Math.min(current * 2, ProviderCallCoordinator.LENGTH_MAX_TOKENS_CAP);
    if (next <= current) return false;
    this.maxTokensOverride = next;
    this.lengthMaxTokensEscalationCount += 1;
    return true;
  }
}
