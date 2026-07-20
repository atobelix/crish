/**
 * Trajectory & Tool Output Compressor
 * 
 * 职责：
 * - 借鉴 Hermes Agent (`trajectory_compressor.py`) 轨迹压缩机制
 * - 针对长轮次多工具调用会话，自动精简历史轮次中的巨型 Tool Output (如大文件 read_file, 巨型 grep_search)
 * - 保留用户原始意图、Assistant 关键决策与最终代码 Diff，移除冗余中间输出
 * - 确保历史 Token 占用保持在最小规模，极大降低重复发送 Tool Output 的 Token 成本
 */

import type { AgentMessage, JsonObject } from "@crish/shared-types";

export interface TrajectoryCompressionOptions {
  /** 超过多少字符的 Tool Output 被认定为巨型输出并压缩 (默认 2,000 字符) */
  maxToolOutputChars?: number;
  /** 保留最近几轮完整的 Tool Output 不压缩 (默认最近 3 轮) */
  keepRecentTurns?: number;
}

/** 压缩历史 Message 轨迹中的巨型 Tool 结果 */
export function compressMessageTrajectory(
  messages: AgentMessage[],
  options: TrajectoryCompressionOptions = {}
): AgentMessage[] {
  const maxChars = options.maxToolOutputChars ?? 2000;
  const keepRecent = options.keepRecentTurns ?? 3;

  if (messages.length <= keepRecent * 2) {
    return messages;
  }

  const cutoffIndex = Math.max(0, messages.length - (keepRecent * 2));

  return messages.map((msg, idx) => {
    // 最近几轮保持原样
    if (idx >= cutoffIndex) {
      return msg;
    }

    // 处理早期轮次中的 Message Block
    const compressedBlocks = msg.blocks.map((block) => {
      if (block.type === "tool-result") {
        const outputStr = typeof block.output === "string"
          ? block.output
          : JSON.stringify(block.output || "");

        if (outputStr.length > maxChars) {
          const firstPart = outputStr.slice(0, 300);
          const lastPart = outputStr.slice(-200);
          const prunedLength = outputStr.length - 500;

          return {
            ...block,
            output: `${firstPart}\n\n... [Trajectory Compressed: Pruned ${prunedLength} chars of historical tool output to save tokens] ...\n\n${lastPart}` as unknown as JsonObject,
          };
        }
      }
      return block;
    });

    return {
      ...msg,
      blocks: compressedBlocks,
    };
  });
}
