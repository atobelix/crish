
/**
 * ContextManager - 上下文管理器
 *
 * �?AgentRuntime 中拆分出来的独立组件，负责：
 * 1. 上下文压缩决�?
 * 2. 消息投影（为 Provider 准备消息�?
 * 3. Token 估算与阈值判�?
 *
 * 关键改进�?
 * - 压缩决策与执行分�?
 * - 投影逻辑集中管理
 * - �?ContextCompressor �?projectMessagesForProvider 对齐
 */

import type {
  AgentMessage,
  ToolOutputBudgetRuntimeOptions,
  ToolCallBlock,
  ToolOutput,
  ToolArtifact,
  JsonObject,
} from "@crish/shared-types";
import type { ContextCompressionRuntimeOptions } from "../types";
import type { PromptAssemblyContextBlock } from "../prompt-assembly";
import { ContextCompressor, type ContextCompressionResult } from "../context-compression";
import { projectMessageForProvider } from "../context-projection";
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
  /**
   * 消息投影增量缓存：以原始 message 引用为键，缓存其投影结果�?
   *
   * 设计依据�?
   * - projectMessageForProvider 是纯函数（仅依赖 message + options），可安全缓�?
   * - options �?ContextManager 构造时固定，整个生命周期不�?
   * - 消息列表追加式增长：每轮只新增末尾消息，�?N-1 条引用不�?�?缓存命中
   * - 压缩�?kept 段保留原引用（slice 不复制对象），缓存仍命中；只有被压缩前缀�?
   *   新的 summary message 是缓存未命中
   * - WeakMap 在消息被丢弃后自�?GC，无内存泄漏风险
   *
   * 仅缓存投影（budget + blob 外部化），不缓存 redact 结果�?
   * redact 依赖 SecretRedactor 内部 placeholder 注册表状态（LRU 可淘汰）�?
   * 缓存 redact 结果可能�?LRU 淘汰后返回过�?placeholder，导�?restore 失败�?
   */
  private readonly projectionCache = new WeakMap<AgentMessage, AgentMessage>();

  constructor(private readonly options: ContextManagerOptions) {
    if (options.compression && options.compression.enabled !== false) {
      this.compressor = new ContextCompressor({
        ...options.compression,
        ...(options.compression.toolOutputBudget !== undefined ? { toolOutputBudget: options.compression.toolOutputBudget } : options.toolOutputBudget !== undefined ? { toolOutputBudget: options.toolOutputBudget } : {})
      } as ContextCompressionRuntimeOptions);
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
   * 判断是否需要压�?
   */
  shouldCompress(messages: AgentMessage[]): boolean {
    if (!this.compressor) return false;
    const decision = this.compressor.shouldCompress(messages, "auto");
    return decision.shouldCompress;
  }

  /**
   * 执行上下文压�?
   */
  async compress(messages: AgentMessage[]): Promise<ContextCompressionResult | null> {
    if (!this.compressor) return null;
    return this.compressor.maybeCompress(messages, "auto");
  }

  /**
   * �?Provider 投影消息（预算控制、blob 外部化、密钥脱敏）�?
   *
   * 单次遍历：对每条消息先查投影缓存（命中则复用），再立即脱敏写入结果槽�?
   * 相比原先「先全量 projectMessagesForProvider 再全�?redactMessages」的两遍遍历�?
   * 减少一次中间数组分配，且未命中缓存的旧消息也只需一次遍历�?
   */
  projectForProvider(messages: AgentMessage[]): AgentMessage[] {
    if (!this.secretRedactor) {
      const result: AgentMessage[] = new Array(messages.length);
      for (let i = 0; i < messages.length; i++) {
        result[i] = this.projectMessageWithCache(messages[i]!);
      }
      return result;
    }
    const result: AgentMessage[] = new Array(messages.length);
    for (let i = 0; i < messages.length; i++) {
      const projected = this.projectMessageWithCache(messages[i]!);
      result[i] = this.secretRedactor.redactMessage(projected).value;
    }
    return result;
  }

  /**
   * 投影单条消息（带 WeakMap 缓存）。命中时直接复用，未命中时计算并写入缓存�?
   */
  private projectMessageWithCache(message: AgentMessage): AgentMessage {
    const cached = this.projectionCache.get(message);
    if (cached) return cached;
    const projected = projectMessageForProvider(message, {
      ...(this.options.toolOutputBudget !== undefined ? { toolOutputBudget: this.options.toolOutputBudget } : {})
    });
    this.projectionCache.set(message, projected);
    return projected;
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
   * 投影提示词上下文块（内容内的密钥同样脱敏�?
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
        ...(context.stableContext !== undefined ? { stableContext: context.stableContext } : {}),
        ...(context.volatileContext !== undefined ? { volatileContext: context.volatileContext } : {})
      };
    }
    const redactBlocks = (blocks: PromptAssemblyContextBlock[]): PromptAssemblyContextBlock[] =>
      blocks.map((block) => {
        const redacted = this.secretRedactor!.redactJson(block.content as never);
        return redacted.redacted ? { ...block, content: redacted.value } : block;
      });
    return {
      ...(context.stableContext !== undefined ? { stableContext: redactBlocks(context.stableContext) } : {}),
      ...(context.volatileContext !== undefined ? { volatileContext: redactBlocks(context.volatileContext) } : {})
    } as any;
  }

  /**
   * 还原 Provider 返回的工具输入（�?[SECRET_n] 占位符换回真值再执行工具�?
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
   * 执行上下文压缩（带事件回调）�?
   *
   * 压缩成功后自动替换消息列表，并通过回调通知调用者记录事件�?
   *
   * @param messages - 当前消息列表（可变引用）
   * @param onEvent - 事件回调（用于记录压缩开�?结束事件�?
   */
  async maybeCompress(
    messages: AgentMessage[],
    replaceMessages: (compressed: AgentMessage[]) => void,
    onEvent: (event: "compression-start" | "compression-end" | "compression-error", detail?: unknown) => Promise<void>
  ): Promise<void> {
    if (!this.compressor) return;
    // 单次 shouldCompress 调用：决策结果同时用于门控（是否启动）和执行（传�?compress 跳过内部重复检查）�?
    // 原先流程会在此处调用 shouldCompress，再经由 this.compress �?compressor.maybeCompress 第二次调�?shouldCompress�?
    const decision = this.compressor.shouldCompress(messages, "auto");
    if (!decision.shouldCompress) return;

    await onEvent("compression-start");

    try {
      // 直接调用 compressor.compress 并传入已�?decision，跳�?compressor.maybeCompress 内部的重�?shouldCompress
      const result = await this.compressor.compress(messages, "auto", decision.tokensBefore, decision);
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
   * 物化大型工具输出：将超过阈值的输出保存�?artifact 文件，返回带预览的精简输出�?
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
   * 获取工具输出 artifact 目录路径�?
   */
  private toolOutputArtifactDir(): string {
    const configured = this.options.toolOutputBudget?.artifactDir;
    const cwd = this.options.cwd ?? process.cwd();
    const sessionId = this.options.sessionId ?? "default";
    if (configured) return isAbsolute(configured) ? configured : resolve(cwd, configured);
    return resolve(cwd, ".codex", "agent-artifacts", sessionId);
  }
}
