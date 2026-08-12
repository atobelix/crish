// 审批卡区块（M4 §2.3 L3：props = 领域类型 + 派生标记，不感知数据来源，F2 §4.2 列表项形态）
// - 展示：风险徽标（L1 灰「需确认」/ L2 红「高风险」）+ 工具名 + 参数摘要（敏感字段打码 last4，
//   F2 §14 R3「敏感参数默认脱敏展示」）+ 会话/run 上下文 + 剩余时间（mm:ss，最后 15s 变红「即将过期」，
//   R2UX-04-06）+ 决策状态行（处理中/待发送/未送达/已过期/冲突，R2UX-04-04/§3.4）
// - 倒计时由父级派生传入（M5 §3.3：本地 interval 不进 store），本组件纯展示。
import { StyleSheet, Text, View } from 'react-native';
import type { ApprovalItem } from '@/domain/types/domain';
import { useTheme } from '@/adapters/platform/theme';

export interface ApprovalCardProps {
  item: ApprovalItem;
  /** 剩余决策时间 ms（expiresAt - now，父级每秒派生） */
  remainingMs: number;
}

// ---------- 纯函数（可单测）：打码 / 摘要 / 倒计时格式 ----------

/** 敏感参数键名匹配（provider key / token / secret / password 等，F2 打码纪律） */
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|credential|authorization|bearer)/i;

/**
 * 参数值打码（保留末 4 位，F2 §14 R3 / PE-07 last4 口径）：
 * 命中敏感键名 → `****<last4>`；值过短（<4）整体打码 `****`；非敏感键原样字符串化。
 */
export function maskSensitiveParamValue(key: string, value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw === undefined) return '';
  if (!SENSITIVE_KEY_PATTERN.test(key)) return raw;
  if (raw.length < 4) return '****';
  return `****${raw.slice(-4)}`;
}

/**
 * 命令行脱敏（详情/卡片的命令类展示）：`--xxx-key <secret>` / `--xxx-key=<secret>` / `Bearer <secret>`
 * 保留末 4 位；非敏感命令原样返回。
 */
export function maskCommandSecrets(command: string): string {
  let out = command;
  out = out.replace(
    /(--?[a-z0-9-]*(?:key|token|secret|password|credential|auth)[a-z0-9-]*)(?:\s*=\s*|\s+)(\S{6,})/gi,
    (_match, flag: string, secret: string) => `${flag}=****${secret.slice(-4)}`
  );
  out = out.replace(
    /(bearer\s+)(\S+)/gi,
    (_match, prefix: string, secret: string) =>
      `${prefix}****${secret.slice(-4)}`
  );
  return out;
}

/** 参数包摘要（打码后拼接 `key=value`，最多 maxLength 字符，超长截断，F2 §4.2-2） */
export function summarizeParameters(
  parameters: ApprovalItem['request']['parameters'],
  maxLength = 80
): string {
  const rec =
    typeof parameters === 'object' &&
    parameters !== null &&
    !Array.isArray(parameters)
      ? (parameters as Record<string, unknown>)
      : null;
  const raw =
    rec === null
      ? typeof parameters === 'string'
        ? parameters
        : JSON.stringify(parameters)
      : Object.entries(rec)
          .map(
            ([key, value]) => `${key}=${maskSensitiveParamValue(key, value)}`
          )
          .join(' · ');
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength - 1)}…`;
}

/** 剩余时间 mm:ss 格式化（F2 §4.2 线框口径：`1:42` / `0:58`） */
export function formatRemainingMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 决策状态行文案映射（F2 §3.3 状态机 / §9.3-6 处理中 / §11.2 冲突 / §8.3 过期 / R2UX-04-05 待发送） */
export function decisionStatusText(
  item: ApprovalItem
): { text: string; tone: 'info' | 'warning' | 'error' | 'muted' } | null {
  if (item.arbiter === 'main-agent') {
    return { text: '等待 Agent 裁决', tone: 'info' };
  }
  switch (item.status) {
    case 'deciding':
      return { text: '处理中…', tone: 'info' };
    case 'queued':
      return { text: '待发送 · 网络恢复后自动发送', tone: 'warning' };
    case 'conflict':
      return { text: '状态可能已变化，点击查看', tone: 'error' };
    case 'expired':
      return { text: '已过期（超过 120 秒），决策未生效', tone: 'muted' };
    case 'approved':
      return { text: '已允许', tone: 'info' };
    case 'denied':
      return { text: '已拒绝', tone: 'error' };
    case 'pending':
      // 决策发送通道失败回滚（F2 §11.3 网络失败 → pending + failed 通道）
      return item.decisionStatus === 'failed'
        ? { text: '决策未送达，将自动重试', tone: 'error' }
        : null;
    default:
      return null;
  }
}

/** 剩余 15 秒警戒线（F2 §4.2 / R2UX-04-06：最后 15s 变红 +「即将过期」） */
export const COUNTDOWN_WARNING_MS = 15_000;

// ---------- 组件 ----------

export default function ApprovalCard({ item, remainingMs }: ApprovalCardProps) {
  const theme = useTheme();
  const isL2 = item.dangerLevel === 2;
  const urgent = remainingMs <= COUNTDOWN_WARNING_MS;
  const status = decisionStatusText(item);
  const isExpired = item.status === 'expired';

  const paramSummary = item.riskMeta?.command
    ? `$ ${maskCommandSecrets(item.riskMeta.command)}`
    : summarizeParameters(item.request.parameters);

  const statusColor =
    status?.tone === 'error'
      ? theme.colorError
      : status?.tone === 'warning'
        ? theme.colorWarning
        : status?.tone === 'info'
          ? theme.colorInfo
          : theme.textSecondary;

  return (
    <View
      testID="approval-card"
      accessible
      accessibilityLabel={`审批卡：${item.request.toolName}，剩余 ${formatRemainingMs(remainingMs)}`}
      style={[
        styles.card,
        { backgroundColor: theme.bgCard, borderColor: theme.hairline },
        isExpired && { opacity: 0.6 },
      ]}
    >
      <View style={styles.headerRow}>
        <View
          testID="risk-badge"
          style={[
            styles.badge,
            { backgroundColor: isL2 ? theme.colorErrorBg : theme.bgTertiary },
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              { color: isL2 ? theme.colorError : theme.textSecondary },
            ]}
          >
            {isL2 ? '高风险' : '需确认'}
          </Text>
        </View>
        <Text
          style={[styles.toolName, { color: theme.textPrimary }]}
          numberOfLines={1}
        >
          {item.request.toolName}
        </Text>
        <View style={styles.countdownArea}>
          <Text
            testID="countdown"
            style={[
              styles.countdown,
              { color: urgent ? theme.colorError : theme.textSecondary },
            ]}
          >
            {formatRemainingMs(remainingMs)}
          </Text>
          {urgent && !isExpired ? (
            <Text
              testID="countdown-warning"
              style={[styles.urgent, { color: theme.colorError }]}
            >
              即将过期
            </Text>
          ) : null}
        </View>
      </View>

      <Text
        testID="param-summary"
        style={[styles.params, { color: theme.textSecondary }]}
        numberOfLines={2}
      >
        {paramSummary}
      </Text>

      <Text style={[styles.context, { color: theme.textTertiary }]}>
        会话 {item.request.sessionId}
        {item.runId !== null ? ` · run ${item.runId}` : ''}
      </Text>

      {status ? (
        <Text
          testID="decision-status"
          style={[styles.status, { color: statusColor }]}
        >
          {status.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '500',
  },
  toolName: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
  },
  countdownArea: {
    alignItems: 'flex-end',
    gap: 2,
  },
  countdown: {
    fontSize: 13,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  urgent: {
    fontSize: 11,
  },
  params: {
    fontSize: 13,
    lineHeight: 18,
  },
  context: {
    fontSize: 12,
  },
  status: {
    fontSize: 13,
    fontWeight: '500',
  },
});
