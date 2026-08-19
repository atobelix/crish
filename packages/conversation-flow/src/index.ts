/**
 * @crish/conversation-flow
 *
 * 叙事投影纯函数：把 SessionMessage 结构编成 FlowNode 树。
 * 本包无 React、无 IPC、无 desktop / block-paper / reference 依赖。
 */

export type {
  ActionKind,
  ActionNode,
  ArtifactNode,
  FlowNode,
  FlowNodeStatus,
  HumanizeHooks,
  MessageSender,
  PendingApproval,
  PlanNode,
  PlanStep,
  ProjectMessageInput,
  ProjectMessageResult,
  ProjectOptions,
  ProjectToolCallInput,
  PurposeNode,
  PurposeStatus,
  SubagentNode,
  TextNode,
  TextTone,
  ThinkingNode,
  ToolCallStatus,
} from './types';

export { DEFAULT_PURPOSE_WINDOW_MS } from './types';

export { projectMessage } from './projectMessage';
export { projectPurposes, toActionNode } from './projectPurposes';
export { extractPendingApprovals } from './extractPendingApprovals';
export {
  deriveArtifactFromTool,
  deriveArtifacts,
  isCodeArtifactPath,
  isDocumentArtifactPath,
  usableArtifactDocId,
} from './deriveArtifacts';
export { isPlanModeEnabled, projectPlanRoot } from './projectPlan';
export type { ProjectPlanInput } from './projectPlan';
