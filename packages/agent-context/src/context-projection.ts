import { budgetToolOutputForContext } from './tool-output-budget';
import {
  externalizeToolOutputBlobs,
  type BlobExternalizationOptions,
} from './blob-externalization';
import {
  guardToolOutputForContext,
  type ToolOutputGuardOptions,
} from './tool-output-guard';
import type {
  AgentMessage,
  AgentMessageBlock,
  ToolResultBlock,
  ToolOutputBudgetRuntimeOptions,
} from '@crish/shared-types';

export interface ContextProjectionOptions {
  toolOutputBudget?: ToolOutputBudgetRuntimeOptions;
  blobExternalization?: false | BlobExternalizationOptions;
  /** Default: guard enabled. Set false to disable untrusted wrapping. */
  toolOutputGuard?: false | ToolOutputGuardOptions;
}

export function projectMessagesForProvider(
  messages: AgentMessage[],
  options: ContextProjectionOptions = {}
): AgentMessage[] {
  return messages.map((message) => projectMessageForProvider(message, options));
}

/**
 * 投影单条消息（budget + blob 外部化）。
 *
 * 导出此函数是为了让上层（ContextManager）可以基于消息引用做增量缓存：
 * 同一 message 引用在上层 WeakMap 命中时直接复用，避免每轮重复投影。
 * 该函数本身仍是纯函数，无副作用。
 */
export function projectMessageForProvider(
  message: AgentMessage,
  options: ContextProjectionOptions
): AgentMessage {
  let changed = false;
  const blocks = message.blocks.map((block) => {
    const projected = projectBlockForProvider(block, options);
    if (projected !== block) changed = true;
    return projected;
  });

  return changed ? { ...message, blocks } : message;
}

function projectBlockForProvider(
  block: AgentMessageBlock,
  options: ContextProjectionOptions
): AgentMessageBlock {
  if (block.type !== 'tool-result') return block;
  return projectToolResultForProvider(block, options);
}

function projectToolResultForProvider(
  block: ToolResultBlock,
  options: ContextProjectionOptions
): ToolResultBlock {
  const externalized =
    options.blobExternalization === false ||
    options.blobExternalization === undefined
      ? block.output
      : externalizeToolOutputBlobs(block.output, options.blobExternalization)
          .value;
  // Order: externalize → budget → guard wrap (raw transcript not destroyed; projection only)
  const budgeted = budgetToolOutputForContext(externalized, {
    ...options.toolOutputBudget,
    toolName: block.toolName,
  });
  const guardOpts =
    options.toolOutputGuard === false
      ? { enabled: false, stripPseudoInstructions: false }
      : { toolName: block.toolName, ...(options.toolOutputGuard ?? {}) };
  const output = guardToolOutputForContext(budgeted, guardOpts);
  return output === block.output ? block : { ...block, output };
}
