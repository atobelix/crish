import { budgetToolOutputForContext } from "./tool-output-budget";
import type { AgentMessage, AgentMessageBlock, ToolOutputBudgetRuntimeOptions, ToolResultBlock } from "./types";

export interface ContextProjectionOptions {
  toolOutputBudget?: ToolOutputBudgetRuntimeOptions;
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
  const output = budgetToolOutputForContext(block.output, {
    ...options.toolOutputBudget,
    toolName: block.toolName
  });
  return output === block.output ? block : { ...block, output };
}
