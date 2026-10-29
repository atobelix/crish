// 审批详情卡：风险、工具、参数摘要、倒计时、状态。
import { StyleSheet, View } from 'react-native';
import type { ApprovalItem } from '@/domain/types/domain';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';

export interface ApprovalCardProps {
  item: ApprovalItem;
  remainingMs: number;
}

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|credential|authorization|bearer)/i;

export function maskSensitiveParamValue(key: string, value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw === undefined) return '';
  if (!SENSITIVE_KEY_PATTERN.test(key)) return raw;
  if (raw.length < 4) return '****';
  return `****${raw.slice(-4)}`;
}

export function maskCommandSecrets(command: string): string {
  let output = command;
  output = output.replace(
    /(--?[a-z0-9-]*(?:key|token|secret|password|credential|auth)[a-z0-9-]*)(?:\s*=\s*|\s+)(\S{6,})/gi,
    (_match, flag: string, secret: string) => `${flag}=****${secret.slice(-4)}`
  );
  output = output.replace(
    /(bearer\s+)(\S+)/gi,
    (_match, prefix: string, secret: string) =>
      `${prefix}****${secret.slice(-4)}`
  );
  return output;
}

export function summarizeParameters(
  parameters: ApprovalItem['request']['parameters'],
  maxLength = 160
): string {
  const record =
    typeof parameters === 'object' &&
    parameters !== null &&
    !Array.isArray(parameters)
      ? (parameters as Record<string, unknown>)
      : null;
  const raw =
    record === null
      ? typeof parameters === 'string'
        ? parameters
        : JSON.stringify(parameters)
      : Object.entries(record)
          .map(
            ([key, value]) => `${key}=${maskSensitiveParamValue(key, value)}`
          )
          .join('\n');
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength - 1)}…`;
}

export function formatRemainingMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function approvalStatusText(
  item: ApprovalItem
): { text: string; tone: 'info' | 'warning' | 'danger' | 'muted' } | null {
  if (item.arbiter === 'main-agent') {
    return { text: '由桌面端自动裁决', tone: 'info' };
  }
  switch (item.status) {
    case 'deciding':
      return { text: '正在提交…', tone: 'info' };
    case 'queued':
      return { text: '等待网络恢复后发送', tone: 'warning' };
    case 'conflict':
      return { text: '状态已变化', tone: 'danger' };
    case 'expired':
      return { text: '已过期', tone: 'muted' };
    case 'approved':
      return { text: '已允许', tone: 'info' };
    case 'denied':
      return { text: '已拒绝', tone: 'danger' };
    case 'pending':
      return item.decisionStatus === 'failed'
        ? { text: '发送失败，将自动重试', tone: 'danger' }
        : null;
    default:
      return null;
  }
}

export const COUNTDOWN_WARNING_MS = 15_000;

export default function ApprovalCard({ item, remainingMs }: ApprovalCardProps) {
  const theme = useTheme();
  const isHighRisk = item.dangerLevel === 2;
  const urgent = remainingMs <= COUNTDOWN_WARNING_MS;
  const status = approvalStatusText(item);
  const expired = item.status === 'expired';
  const summary = item.riskMeta?.command
    ? `$ ${maskCommandSecrets(item.riskMeta.command)}`
    : summarizeParameters(item.request.parameters);
  const statusColor =
    status?.tone === 'danger'
      ? theme.colors.danger
      : status?.tone === 'warning'
        ? theme.colors.warning
        : status?.tone === 'info'
          ? theme.colors.info
          : theme.colors.textTertiary;

  return (
    <View
      testID="approval-card"
      style={[styles.container, expired && styles.expired]}
    >
      <View style={styles.header}>
        <View
          style={[
            styles.riskBadge,
            { borderRadius: theme.radius.xs },
            {
              backgroundColor: isHighRisk
                ? theme.colors.dangerSoft
                : theme.colors.fillSubtle,
            },
          ]}
        >
          <AppText
            variant="caption"
            style={{
              color: isHighRisk
                ? theme.colors.danger
                : theme.colors.textSecondary,
            }}
          >
            {isHighRisk ? '高风险' : '需确认'}
          </AppText>
        </View>
        <AppText variant="title2" numberOfLines={1} style={styles.toolName}>
          {item.request.toolName}
        </AppText>
        <View style={styles.countdown}>
          {!expired ? (
            <Icon
              name="clock"
              size={14}
              color={urgent ? theme.colors.danger : theme.colors.textTertiary}
            />
          ) : null}
          <AppText
            variant="footnote"
            style={{
              color: urgent ? theme.colors.danger : theme.colors.textSecondary,
              fontVariant: ['tabular-nums'],
            }}
          >
            {expired ? '已过期' : formatRemainingMs(remainingMs)}
          </AppText>
        </View>
      </View>

      {summary ? (
        <View
          style={[
            styles.summaryBox,
            { borderRadius: theme.radius.sm },
            { backgroundColor: theme.colors.fillSubtle },
          ]}
        >
          <AppText
            variant="mono"
            color="textSecondary"
            numberOfLines={6}
            selectable
          >
            {summary}
          </AppText>
        </View>
      ) : null}

      {status ? (
        <AppText
          testID="approval-status"
          variant="footnote"
          style={{ color: statusColor }}
        >
          {status.text}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  expired: {
    opacity: 0.55,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  riskBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  toolName: {
    flex: 1,
  },
  countdown: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  summaryBox: {
    padding: 12,
  },
});
