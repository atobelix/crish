/**
 * ContextManager - 上下文管理器
 *
 * 从 AgentRuntime 中拆分出来的独立组件，负责：
 * 1. 上下文压缩决策
 * 2. 消息投影（为 Provider 准备消息）
 * 3. Token 估算与阈值判断
 *
 * 关键改进：
 * - 压缩决策与执行分离
 * - 投影逻辑集中管理
 * - 与 ContextCompressor 和 projectMessagesForProvider 对齐
 */

import type {
  AgentMessage,
  AgentEvent,
  ContextCompressionRecord,
  ToolOutputBudgetRuntimeOptions,
  ToolCallBlock,
  ToolOutput,
  ToolArtifact,
  JsonObject,
} from "@crish/shared-types";
import type { ContextCompressionRuntimeOptions } from "../types";
import type { PromptAssemblyContextBlock } from "../prompt-assembly";
import { ContextCompressor, type ContextCompressionResult } from "../context-compression";
import { projectMessagesForProvider, type ContextProjectionOptions } from "../context-projection";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { budgetTextForContext } from "../tool-output-budget";
import { safeArtifactName } from "../runtime-helpers";
import {
  createSecretRedactorFromEnv,
  type SecretRedactor,
} from "../secrets-obfuscation";

// ─── 上下文管理器配置 ─────────────────────────────────────

export interface ContextManagerOptions {
  compression?: ContextCompressionRuntimeOptions;
  toolOutputBudget?: ToolOutputBudgetRuntimeOptions;
  /** 当前工作目录（用于工具输出物化路径） */
  cwd?: string;
  /** 会话 ID（用于工具输出物化路径） */
  sessionId?: string;
  /**
   * Secret redactor for provider-bound projection (default: env-based).
   * Pass `false` to disable; pass a custom SecretRedactor for tests.
   */
  secretRedactor?: SecretRedactor | false;
}

// ─── 上下文管理器 ─────────────────────────────────────────

export class ContextManager {
  private compressor?: ContextCompressor;
  private readonly secretRedactor: SecretRedactor | undefined;

  constructor(private readonly options: ContextManagerOptions) {
    if (options.compression && options.compression.enabled !== false) {
      this.compressor = new ContextCompressor({
        ...options.compression,
        toolOutputBudget: options.compression.toolOutputBudget ?? options.toolOutputBudget
      });
    }
    if (options.secretRedactor === false) {
      this.secretRedactor = undefined;
    } else if (options.secretRedactor) {
      this.secretRedactor = options.secretRedactor;
    } else {
      // Default product path: redact process.env secrets before provider wire
      this.secretRedactor = createSecretRedactorFromEnv(process.env);
    }
  }

  /**
   * 判断是否需要压缩
   */
  shouldCompress(messages: AgentMessage[]): boolean {
    if (!this.compressor) return false;
    const decision = this.compressor.shouldCompress(messages, "auto");
    return decision.shouldCompress;
  }

  /**
   * 执行上下文压缩
   */
  async compress(messages: AgentMessage[]): Promise<ContextCompressionResult | null> {
    if (!this.compressor) return null;
    return this.compressor.maybeCompress(messages, "auto");
  }

  /**
   * 为 Provider 投影消息（预算控制、blob 外部化、密钥脱敏）
   */
  projectForProvider(messages: AgentMessage[]): AgentMessage[] {
    const projected = projectMessagesForProvider(messages, {
      toolOutputBudget: this.options.toolOutputBudget
    });
    if (!this.secretRedactor) return projected;
    return this.secretRedactor.redactMessages(projected).value;
  }

  /**
   * 投影系统提示词（含密钥脱敏）
   */
  projectSystemPrompt(systemPrompt: string | undefined): string | undefined {
    if (!systemPrompt) return systemPrompt;
    if (!this.secretRedactor) return systemPrompt;
    return this.secretRedactor.redactText(systemPrompt).value;
  }

  /**
   * 投影提示词上下文块（内容内的密钥同样脱敏）
   */
  projectPromptContext(context: {
    stableContext?: PromptAssemblyContextBlock[];
    volatileContext?: PromptAssemblyContextBlock[];
  } | undefined): {
    stableContext?: PromptAssemblyContextBlock[];
    volatileContext?: PromptAssemblyContextBlock[];
  } {
    if (!context) return {};
    if (!this.secretRedactor) {
      return {
        stableContext: context.stableContext,
        volatileContext: context.volatileContext
      };
    }
    const redactBlocks = (blocks: PromptAssemblyContextBlock[] | undefined) =>
      blocks?.map((block) => {
        const redacted = this.secretRedactor!.redactJson(block.content as never);
        return redacted.redacted ? { ...block, content: redacted.value } : block;
      });
    return {
      stableContext: redactBlocks(context.stableContext),
      volatileContext: redactBlocks(context.volatileContext)
    };
  }

  /**
   * 还原 Provider 返回的工具输入（把 [SECRET_n] 占位符换回真值再执行工具）
   */
  restoreProviderToolInput(input: JsonObject): JsonObject {
    if (!this.secretRedactor) return input;
    return this.secretRedactor.restoreJson(input) as JsonObject;
  }

  /**
   * 获取压缩器实例（供外部使用）
   */
  getCompressor(): ContextCompressor | undefined {
    return this.compressor;
  }

  /**
   * 执行上下文压缩（带事件回调）。
   *
   * 压缩成功后自动替换消息列表，并通过回调通知调用者记录事件。
   *
   * @param messages - 当前消息列表（可变引用）
   * @param onEvent - 事件回调（用于记录压缩开始/结束事件）
   */
  async maybeCompress(
    messages: AgentMessage[],
    replaceMessages: (compressed: AgentMessage[]) => void,
    onEvent: (event: "compression-start" | "compression-end" | "compression-error", detail?: unknown) => Promise<void>
  ): Promise<void> {
    if (!this.shouldCompress(messages)) return;

    await onEvent("compression-start");

    try {
      const result = await this.compress(messages);
      if (!result) {
        await onEvent("compression-end", { aborted: true, error: "No compressible context region" });
        return;
      }

      replaceMessages(result.messages);
      await onEvent("compression-end", { record: result.record, aborted: false });
    } catch (cause) {
      await onEvent("compression-error", cause instanceof Error ? cause.message : String(cause));
    }
  }

  /**
   * 物化大型工具输出：将超过阈值的输出保存为 artifact 文件，返回带预览的精简输出。
   */
  async materializeOutput(toolCall: ToolCallBlock, output: ToolOutput): Promise<ToolOutput> {
    if (typeof output.text !== "string") return output;
    const threshold = this.options.toolOutputBudget?.artifactChars ?? 200_000;
    if (output.text.length <= threshold) return output;

    const artifactDir = this.toolOutputArtifactDir();
    await mkdir(artifactDir, { recursive: true });
    const hash = createHash("sha256").update(output.text).digest("hex");
    const fileName = `${safeArtifactName(toolCall.toolName)}-${safeArtifactName(toolCall.id)}-${hash.slice(0, 16)}.log`;
    const filePath = join(artifactDir, fileName);
    await writeFile(filePath, output.text, "utf8");

    const previewChars = Math.min(this.options.toolOutputBudget?.inlineChars ?? 4_000, 4_000);
    const preview = budgetTextForContext(output.text, { inlineChars: previewChars, headRatio: this.options.toolOutputBudget?.headRatio });
    const artifact: ToolArtifact = {
      kind: "log",
      title: `Full tool output: ${toolCall.toolName}`,
      uri: filePath,
      metadata: {
        artifactKind: "tool-output",
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        originalChars: output.text.length,
        sha256: hash,
        artifactPath: filePath
      }
    };

    return {
      ...output,
      text: `Full tool output saved to artifact: ${filePath}\nOriginal characters: ${output.text.length.toLocaleString("en-US")}\n\nPreview:\n${preview.text}`,
      artifacts: [...(output.artifacts ?? []), artifact]
    };
  }

  /**
   * 获取工具输出 artifact 目录路径。
   */
  private toolOutputArtifactDir(): string {
    const configured = this.options.toolOutputBudget?.artifactDir;
    const cwd = this.options.cwd ?? process.cwd();
    const sessionId = this.options.sessionId ?? "default";
    if (configured) return isAbsolute(configured) ? configured : resolve(cwd, configured);
    return resolve(cwd, ".codex", "agent-artifacts", sessionId);
  }
}
