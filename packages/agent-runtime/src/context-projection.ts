import { budgetToolOutputForContext } from "./tool-output-budget";
import { externalizeToolOutputBlobs, type BlobExternalizationOptions } from "./blob-externalization";
import type { AgentMessage, AgentMessageBlock, ToolResultBlock } from "@crish/shared-types";
import type { ToolOutputBudgetRuntimeOptions } from "./types";

export interface ContextProjectionOptions {
  toolOutputBudget?: ToolOutputBudgetRuntimeOptions;
  blobExternalization?: false | BlobExternalizationOptions;
}

export function projectMessagesForProvider(messages: AgentMessage[], options: ContextProjectionOptions = {}): AgentMessage[] {
  return messages.map((message) => projectMessageForProvider(message, options));
}

function projectMessageForProvider(message: AgentMessage, options: ContextProjectionOptions): AgentMessage {
  let changed = false;
  const blocks = message.blocks.map((block) => {
    const projected = projectBlockForProvider(block, options);
    if (projected !== block) changed = true;
    return projected;
  });

  return changed ? { ...message, blocks } : message;
}

function projectBlockForProvider(block: AgentMessageBlock, options: ContextProjectionOptions): AgentMessageBlock {
  if (block.type !== "tool-result") return block;
  return projectToolResultForProvider(block, options);
}

function projectToolResultForProvider(block: ToolResultBlock, options: ContextProjectionOptions): ToolResultBlock {
  const externalized =
    options.blobExternalization === false || options.blobExternalization === undefined
      ? block.output
      : externalizeToolOutputBlobs(block.output, options.blobExternalization).value;
  const output = budgetToolOutputForContext(externalized, {
    ...options.toolOutputBudget,
    toolName: block.toolName
  });
  return output === block.output ? block : { ...block, output };
}
