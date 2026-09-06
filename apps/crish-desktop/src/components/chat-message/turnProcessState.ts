/**
 * apps/crish-desktop/src/components/chat-message/turnProcessState.ts
 * 7 布尔量折叠状态机全参数契约与纯逻辑数学推导
 */

import type { AssistantTimelineItem } from '../../api/toolPresentation';
import type { SessionMessage, SessionMessageStatus } from '../../store/types';

export type TurnMessageStatus = SessionMessageStatus | 'stopped';

/**
 * 7 布尔量折叠状态机全参数契约
 */
export interface TurnProcessFoldingState {
  /** ① 折叠视窗就绪：消息进入终态（非 live / 非 queued）、存在过程槽位且历史记录完整 */
  processWindowReady: boolean;

  /** ② 过程成员判定：属于思考或工具调用等中间探索产物 */
  processMember: boolean;

  /** ③ 最终回答判定：当前项属于本轮次终结论正文 */
  processAnswer: boolean;

  /** ④ 折叠控制所有权：谁来承载折叠控制栏（主控槽位持有） */
  ownsDisclosure: boolean;

  /** ⑤ 可折叠资格：确实存在前置工具调用或思考链，杜绝无内容空折叠栏 */
  foldable: boolean;

  /** ⑥ 紧凑回答视觉节拍：收起时折叠栏与正文间距压缩为 8px 紧密贴合 */
  compactAnswer: boolean;

  /** ⑦ 最终隐藏裁决：属于折叠中的过程成员，执行隐藏并挂载 hidden="until-found" */
  processHidden: boolean;
}

export interface ProcessMetrics {
  toolCount: number;
  thoughtCount: number;
  durationMs: number;
}

/**
 * 提取过程指标纯函数
 */
export function countProcessMetrics(
  items?: AssistantTimelineItem[] | null
): ProcessMetrics {
  let toolCount = 0;
  let thoughtCount = 0;
  let durationMs = 0;

  if (!Array.isArray(items)) {
    return { toolCount, thoughtCount, durationMs };
  }

  for (const item of items) {
    if (!item) continue;
    if (item.kind === 'tools' && Array.isArray(item.items)) {
      for (const t of item.items) {
        if (!t) continue;
        if (t.kind === 'single') {
          toolCount += 1;
        } else if (t.kind === 'group' && Array.isArray(t.tools)) {
          toolCount += t.tools.length;
        }
      }
    } else if (item.kind === 'thought') {
      thoughtCount += 1;
      if (typeof item.durationMs === 'number' && item.durationMs > 0) {
        durationMs += item.durationMs;
      }
    }
  }

  return { toolCount, thoughtCount, durationMs };
}

/**
 * 纯工具调用轮次终态闭环判定纯函数
 */
export function isToolOnlyTerminalTurn(params: {
  isTurnLive?: boolean;
  turnStatus?: SessionMessage['status'] | string;
  msgStatus?: SessionMessage['status'] | string;
  status?: SessionMessage['status'] | string;
  hasFinalAnswer?: boolean;
  toolCount?: number;
}): boolean {
  if (!params) return false;
  const isTurnLive = Boolean(params.isTurnLive);
  const status = params.turnStatus ?? params.msgStatus ?? params.status;
  const hasFinalAnswer = Boolean(params.hasFinalAnswer);
  const toolCount = params.toolCount ?? 0;

  return (
    !isTurnLive &&
    (status === 'completed' || status === 'stopped') &&
    !hasFinalAnswer &&
    toolCount >= 2
  );
}

/**
 * 状态机核心推导纯函数
 */
export function deriveTurnProcessState(params: {
  isTurnLive: boolean;
  msgStatus: TurnMessageStatus | undefined;
  itemKind: AssistantTimelineItem['kind'];
  isFinalAnswer: boolean;
  hasToolsOrThinking: boolean;
  toolCount: number;
  userExpanded: boolean;
  compactPreference?: boolean;
}): TurnProcessFoldingState {
  const {
    isTurnLive,
    msgStatus,
    itemKind,
    isFinalAnswer,
    hasToolsOrThinking,
    toolCount,
    userExpanded,
    compactPreference = true,
  } = params;

  // 1. processWindowReady：非生成中、非排队中，进入终态结算
  const isTerminal = msgStatus === 'completed' || msgStatus === 'stopped' || msgStatus === 'error';
  const processWindowReady = !isTurnLive && isTerminal;

  // 2. processMember：属于过程成员（思考项、工具项、或者非最终答案的中间过渡文本）
  const processMember =
    processWindowReady &&
    (itemKind === 'thought' || itemKind === 'tools' || (itemKind === 'text' && !isFinalAnswer));

  // 3. processAnswer：当前项为定局正文
  const processAnswer = processWindowReady && itemKind === 'text' && isFinalAnswer;

  // 4. ownsDisclosure：拥有折叠控制权（过程栏宿主 或 定局正文锚点）
  const ownsDisclosure = processWindowReady && (hasToolsOrThinking || toolCount >= 2);

  // 5. Tool-Only 终态纯工具轮次分支破除死局
  const isToolOnlyTerminal =
    processWindowReady && !isFinalAnswer && toolCount >= 2;

  // 6. foldable：具有折叠资格
  const foldable =
    processWindowReady &&
    (processMember || ownsDisclosure) &&
    (hasToolsOrThinking || isToolOnlyTerminal);

  // 7. compactAnswer：紧凑模式间距（折叠收起态时启用 8px 节拍）
  const compactAnswer = processAnswer && foldable && compactPreference && !userExpanded;

  // 8. processHidden：节点最终隐藏裁决（满足折叠条件且用户未手动展开）
  const processHidden = foldable && processMember && !userExpanded;

  return {
    processWindowReady,
    processMember,
    processAnswer,
    ownsDisclosure,
    foldable,
    compactAnswer,
    processHidden,
  };
}
