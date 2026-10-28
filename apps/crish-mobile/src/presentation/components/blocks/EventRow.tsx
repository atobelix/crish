// 事件流行（F3 §3.3 渲染面 / F1 §4.3 时间线行形态）：
// - kind → 短标签 + 人话摘要（F3 §6.3 人话摘要语义的本地实现——toolHumanLabel 共享包
//   未迁移，用简单映射 + 标注，摘要函数纯函数导出供单测）；
// - 摘要渲染统一脱敏（R4 批次5：clipSummary 内 redactSecrets——sk-/Bearer/凭据键值
//   打码，与桌面 redact 同规范，T-09 移动端侧；流式/终值共用同一出口）；
// - 错误高亮（F3 §3.3.3：runtime-error / run-terminal failed / tool-end isError /
//   task-failed / security-audit blocked——deriveErrorLevel 复用 eventReducers）；
// - 流式渲染（R2UX-05-02）：流式增量类型（message-delta / tool-update / task-output）
//   经 StreamingText 节流渐进渲染（preview 帧 18ms 合并 / 100ms 强制刷新 / 终值立即），
//   行尾静态「▍」光标（R2UX-02-06-3 / 裁决 A3：静态光标不构成逐字动画）；
// - 未知 type 保真兜底「事件 <type>」（F1 §4.3：不丢不猜）；
// - 固定行高（EVENT_ROW_HEIGHT）供 FlatList 虚拟化 getItemLayout。
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { redactSecrets } from '@crish/shared-utils';
import type {
  EventEnvelopeFrame,
  FeedEntry,
} from '@/domain/store/eventReducers';
import {
  deriveErrorLevel,
  readBool,
  readNumber,
  readRecord,
  readString,
} from '@/domain/store/eventReducers';
import { STREAMING_TYPES } from '@/domain/pure/streamingTypes';
import { useTheme } from '@/adapters/platform/theme';
import { StreamingText } from './StreamingText';

export { STREAMING_TYPES };

/** 固定行高（虚拟化 getItemLayout 数据面，R2UX-05-01） */
export const EVENT_ROW_HEIGHT = 56;

/** 只看工具 kind 白名单（F3 §5.1：tool-card + task-card + audit-card 条目类型集合） */
export const TOOL_KIND_WHITELIST: ReadonlySet<string> = new Set([
  'tool-start',
  'tool-update',
  'tool-end',
  'approval-requested',
  'approval-resolved',
  'task-started',
  'task-output',
  'task-suspicious',
  'task-completed',
  'task-failed',
  'task-killed',
  'security-audit',
]);

/** 事件 kind → 短标签（行内 chip 文案；未登记 type 原样展示保真） */
export function eventKindLabel(frame: EventEnvelopeFrame): string {
  switch (frame.type) {
    case 'agent-start':
    case 'agent-end':
      return '代理';
    case 'run-terminal':
      return '结束';
    case 'message-start':
    case 'message-delta':
    case 'message-end':
      return '消息';
    case 'tool-start':
    case 'tool-update':
    case 'tool-end':
      return '工具';
    case 'approval-requested':
    case 'approval-resolved':
      return '审批';
    case 'runtime-error':
    case 'runtime-intervention-required':
      return '错误';
    case 'task-started':
    case 'task-output':
    case 'task-suspicious':
    case 'task-completed':
    case 'task-failed':
    case 'task-killed':
      return '任务';
    case 'security-audit':
      return '审计';
    case 'context-compression-start':
    case 'context-compression-end':
      return '压缩';
    case 'cache-stats-updated':
    case 'cache-waste-alert':
    case 'cold-cache-warning':
      return '缓存';
    case 'timer-fired':
    case 'cron-fired':
      return '定时';
    default:
      return frame.type;
  }
}

/** 摘要截断（单行预览上限 60 字符，F3 §3.4.2 折叠预览语义的本地收窄；
 * 脱敏先于截断（R4 批次5）：sk-/Bearer/凭据键值在进入摘要前打码） */
export function clipSummary(text: string, maxLength = 60): string {
  const trimmed = redactSecrets(text.replace(/\s+/g, ' ').trim());
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

/**
 * 事件人话摘要（F3 §6.3 语义：toolHumanLabel 共享包未迁移，先以简单映射 + 标注落地；
 * 未知 type 保真兜底「事件 <type>」）。字段读取走宽容 read* 助手（缺失 → 缺省文案）。
 * 流式增量类型不在此追加光标——由 StreamingText 按 STREAMING_TYPES 统一渲染
 * 「▍」（单一渲染位，R2UX-05-02）。
 */
export function summarizeEventFrame(frame: EventEnvelopeFrame): string {
  const runId = readString(frame, 'runId');
  const runNote = runId ? `（run ${runId}）` : '';
  switch (frame.type) {
    case 'agent-start':
      return `Agent 开始执行${runNote}`;
    case 'agent-end':
      return `Agent 结束${runNote}：${readString(frame, 'reason') ?? '无 reason'}`;
    case 'run-terminal':
      return `run 结束（${readString(frame, 'terminal') ?? 'unknown'}）${runNote}`;
    case 'message-delta':
      return clipSummary(`正文增量：${readString(frame, 'text') ?? ''}`);
    case 'message-end':
      return `消息完成${runNote}`;
    case 'tool-start':
      return `工具 ${readString(frame, 'toolName') ?? 'unknown'} 启动${runNote}`;
    case 'tool-update': {
      // update.text（S1 协议，tool_events.rs）；宽容两级读取（缺省空文案）
      const update = readRecord(frame['update']);
      return clipSummary(`工具输出：${readString(update, 'text') ?? ''}`);
    }
    case 'tool-end':
      return `工具 ${readString(frame, 'toolName') ?? 'unknown'} ${
        readBool(frame, 'result', 'isError') ? '失败' : '完成'
      }${runNote}`;
    case 'approval-requested': {
      const summary = readString(frame, 'summary');
      return summary
        ? `需要确认：${readString(frame, 'toolName') ?? 'unknown'}（${clipSummary(summary)}）`
        : `需要确认：${readString(frame, 'toolName') ?? 'unknown'}${runNote}`;
    }
    case 'approval-resolved':
      return `审批已处理（${readString(frame, 'decision') ?? 'unknown'}）`;
    case 'runtime-error':
      return `运行错误：${clipSummary(readString(frame, 'error') ?? '未知错误')}`;
    case 'runtime-intervention-required':
      return `需要人工介入：${clipSummary(readString(frame, 'reason') ?? '')}`;
    case 'task-started':
      return `后台任务启动：${clipSummary(
        readString(frame, 'command') ?? readString(frame, 'summary') ?? ''
      )}`;
    case 'task-output':
      return clipSummary(
        `任务输出：${readString(frame, 'line') ?? readString(frame, 'chunk') ?? ''}`
      );
    case 'task-suspicious':
      return '任务疑似卡死（N 秒无输出）';
    case 'task-completed':
      return `任务完成（exit ${readNumber(frame, 'exitCode') ?? 0}）`;
    case 'task-failed':
      return `任务失败（exit ${readNumber(frame, 'exitCode') ?? '?'}）`;
    case 'task-killed':
      return `任务已终止${readBool(frame, 'viaForce') ? '（强制）' : ''}`;
    case 'security-audit':
      return `安全审计：${readString(frame, 'operation') ?? 'unknown'}（${readString(frame, 'decision') ?? 'unknown'}）`;
    case 'context-compression-start':
      return `上下文压缩中（${readNumber(frame, 'tokensBefore') ?? '?'} tokens）`;
    case 'context-compression-end':
      return `上下文压缩${readString(frame, 'status') === 'error' ? '失败' : '完成'}`;
    case 'cache-waste-alert':
      return `缓存浪费：约 ${readNumber(frame, 'missedTokens') ?? '?'} tokens`;
    case 'cold-cache-warning':
      return '缓存已过期，下次重发将全部重算';
    case 'cache-stats-updated': {
      const hitRatio = readNumber(frame, 'hitRatio');
      return hitRatio !== undefined
        ? `缓存统计更新（命中 ${Math.round(hitRatio * 100)}%）`
        : '缓存统计更新';
    }
    case 'turn-start':
      return `第 ${readNumber(frame, 'turnIndex') ?? '?'} 轮开始`;
    case 'turn-end':
      return `第 ${readNumber(frame, 'turnIndex') ?? '?'} 轮结束（${readNumber(frame, 'toolCallCount') ?? 0} 次工具调用）`;
    case 'timer-fired':
      return `定时器到期：${clipSummary(readString(frame, 'prompt') ?? '')}`;
    case 'cron-fired':
      return `cron 第 ${readNumber(frame, 'fireCount') ?? '?'} 次触发：${clipSummary(readString(frame, 'prompt') ?? '')}`;
    case 'subagent-started':
      return `协作子任务启动：${clipSummary(readString(frame, 'description') ?? '')}`;
    case 'subagent-ended':
      return `协作子任务结束（${readString(frame, 'status') ?? 'unknown'}）`;
    default:
      // 保真兜底（F1 §4.3 / F3 §2.12：未知 type 不丢不猜）
      return `事件 ${frame.type}`;
  }
}

/** 本地收达时间 HH:mm:ss（feed 行时间，F1 §4.3 时间线行形态） */
export function formatFeedTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 事件行条目稳定键（FlatList keyExtractor 与流式 identity 共用单一公式：
 * type + sequence 幂等键 + receivedAtMs 兜底——同 seq 覆盖保留首次收达时间，键稳定
 * 不重挂载（不闪烁）；F3 §3.1.1 防重放语义） */
export function feedEntryKey(entry: FeedEntry): string {
  return `${entry.sessionId}:${entry.type}:${entry.sequence ?? 'seq-null'}:${entry.receivedAtMs}`;
}

export interface EventRowProps {
  entry: FeedEntry;
}

/** 事件行（memo：流式追加时历史行零重渲染，R2UX-05-01 行 memo 纪律；
 * 流式摘要经 StreamingText 节流渐进渲染——preview 帧同 seq 覆盖同节点更新） */
export const EventRow = memo(function EventRow({ entry }: EventRowProps) {
  const theme = useTheme();
  const isError = deriveErrorLevel(entry);
  const streaming = STREAMING_TYPES.has(entry.type);
  const summary = summarizeEventFrame(entry);

  return (
    <View
      testID={isError ? 'event-row-error' : 'event-row'}
      accessible
      accessibilityLabel={`事件 ${eventKindLabel(entry)}：${summary}`}
      style={[
        styles.row,
        { borderBottomColor: theme.hairline },
        isError && {
          backgroundColor: theme.colorErrorBg,
          borderLeftColor: theme.colorError,
        },
      ]}
    >
      <Text
        testID="event-row-time"
        style={[styles.time, { color: theme.textTertiary }]}
      >
        {formatFeedTime(entry.receivedAtMs)}
      </Text>
      <View
        testID="event-row-kind"
        style={[
          styles.kindChip,
          {
            backgroundColor: isError ? theme.colorErrorBg : theme.bgTertiary,
          },
        ]}
      >
        <Text
          style={[
            styles.kindText,
            { color: isError ? theme.colorError : theme.textSecondary },
          ]}
        >
          {eventKindLabel(entry)}
        </Text>
      </View>
      <StreamingText
        testID="event-row-summary"
        identity={feedEntryKey(entry)}
        text={summary}
        streaming={streaming}
        cursorTestID="event-row-streaming"
        cursorStyle={{ color: theme.textTertiary }}
        style={[
          styles.summary,
          { color: isError ? theme.colorError : theme.textPrimary },
        ]}
        numberOfLines={1}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    height: EVENT_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  time: {
    width: 64,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  kindChip: {
    minWidth: 36,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignItems: 'center',
  },
  kindText: {
    fontSize: 11,
    fontWeight: '500',
  },
  summary: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
});
