// 审批悬浮卡展开态（原型 conv-approval-floating-popup）：
// 白卡 30 圆角 + 柔和深度投影；标题行（琥珀点 + 权限审批请求 13.5/600 + 收起）；
// 元信息行（工具标签 10.5/500 + 倒计时 + 队列入口）；等宽代码摘要块；决策按钮对。
// 按钮对为卡内本地胶囊（原型 h38：拒绝浅底灰字 / 允许绿底白字），不走 ui/Button。
// 低风险卡内直接「拒绝 / 允许」；高风险只给「查看并滑动确认」；点空白处回到所属会话。
// 注：字号/圆角定值按 token 守卫写成 theme 表达式（13.5 = bodyStrong − 2.5 等），值与原型一致。
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { ApprovalItem } from '@/domain/types/domain';
import { AppText, IconButton } from '@/presentation/ui';
import {
  COUNTDOWN_WARNING_MS,
  formatRemainingMs,
  maskCommandSecrets,
  summarizeParameters,
} from '@/presentation/components/blocks/ApprovalCard';
import type { ApprovalFloatMode } from './approvalFloatModel';

export interface ApprovalFloatCardProps {
  item: ApprovalItem;
  mode: ApprovalFloatMode;
  others: number;
  remainingMs: number;
  busy: boolean;
  onAllow: () => void;
  onDeny: () => void;
  onReview: () => void;
  onOpenQueue: () => void;
  onOpenSession: () => void;
  onCollapse: () => void;
}

function summaryOf(item: ApprovalItem): string {
  return item.riskMeta?.command
    ? `$ ${maskCommandSecrets(item.riskMeta.command)}`
    : summarizeParameters(item.request.parameters, 120);
}

export function ApprovalFloatCard({
  item,
  mode,
  others,
  remainingMs,
  busy,
  onAllow,
  onDeny,
  onReview,
  onOpenQueue,
  onOpenSession,
  onCollapse,
}: ApprovalFloatCardProps) {
  const theme = useTheme();
  const urgent = remainingMs <= COUNTDOWN_WARNING_MS;
  const summary = summaryOf(item);
  return (
    <Pressable
      testID="approval-float-card"
      accessibilityRole="button"
      accessibilityLabel={`待审批：${item.request.toolName}，打开所属会话`}
      onPress={onOpenSession}
      style={[
        {
          // 原型 conv-approval-floating-popup：padding 16/18、gap 12
          paddingVertical: theme.space.lg,
          paddingHorizontal: 18,
          gap: theme.space.md,
          borderRadius: theme.radius.overlay,
          backgroundColor: theme.colors.surfaceRaised,
        },
        theme.shadow.lg,
      ]}
    >
      <View style={[styles.row, styles.titleRow]}>
        {/* 状态点 + 固定标题（工具语义见元信息行标签） */}
        <View
          style={[
            styles.dot,
            {
              borderRadius: theme.radius.pill,
              backgroundColor:
                mode === 'review' ? theme.colors.danger : theme.colors.warning,
            },
          ]}
        />
        <AppText
          variant="bodyStrong"
          numberOfLines={1}
          style={[
            styles.flex,
            {
              // 原型 conv-floating-title：13.5/600（守卫口径：theme 表达式落值）
              fontSize: (theme.type.bodyStrong.fontSize ?? 16) - 2.5,
              lineHeight: theme.type.footnote.lineHeight ?? 18,
              fontWeight: '600',
              letterSpacing: 0,
            },
          ]}
        >
          权限审批请求
        </AppText>
        <IconButton
          name="chevron-down"
          accessibilityLabel="收起审批"
          onPress={onCollapse}
          size={theme.size.iconSmall}
          testID="approval-float-collapse"
        />
      </View>
      <View style={[styles.row, { gap: theme.space.sm }]}>
        <AppText
          variant="caption"
          color="textTertiary"
          numberOfLines={1}
          style={[
            styles.flex,
            {
              // 原型 conv-floating-tag：10.5/500、字距 0.02em（≈0.21px）、不再大写变形
              fontSize: (theme.type.caption.fontSize ?? 12.5) - 2,
              lineHeight: (theme.type.caption.lineHeight ?? 16) - 2,
              fontWeight: '500',
              letterSpacing: 0.21,
            },
          ]}
        >
          {item.request.toolName}
        </AppText>
        {others > 0 ? (
          <Pressable
            testID="approval-float-more"
            accessibilityRole="button"
            accessibilityLabel={`还有 ${others} 个待审批，打开队列`}
            onPress={onOpenQueue}
            hitSlop={theme.space.sm}
          >
            <AppText variant="caption" color="brand">
              还有 {others} 个
            </AppText>
          </Pressable>
        ) : null}
        <AppText
          variant="caption"
          color={urgent ? 'danger' : 'textTertiary'}
          style={styles.tabular}
        >
          {formatRemainingMs(remainingMs)}
        </AppText>
      </View>
      {summary ? (
        <View
          style={{
            // 原型 conv-floating-code：浅填充底、radius 16（codeCell 档同值）、padding 10/14、mono 12
            borderRadius: theme.radius.codeCell,
            backgroundColor: theme.colors.fillSubtle,
            paddingVertical: 10,
            paddingHorizontal: 14,
          }}
        >
          <AppText variant="mono" color="textPrimary" numberOfLines={3}>
            {summary}
          </AppText>
        </View>
      ) : null}
      {mode === 'quick' ? (
        <View style={[styles.row, styles.actionsRow]}>
          <Pressable
            testID="approval-float-deny"
            accessibilityRole="button"
            accessibilityLabel="拒绝"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={onDeny}
            style={({ pressed }) => [
              styles.capsule,
              styles.flex,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: pressed
                  ? theme.colors.fillPressed
                  : theme.colors.fillSubtle,
              },
            ]}
          >
            <AppText
              variant="body"
              color="textSecondary"
              style={{
                // 原型 conv-btn-floating-deny 字：13/500
                fontSize: (theme.type.caption.fontSize ?? 12.5) + 0.5,
                lineHeight: theme.type.footnote.lineHeight ?? 18,
                fontWeight: '500',
              }}
            >
              拒绝
            </AppText>
          </Pressable>
          <Pressable
            testID="approval-float-allow"
            accessibilityRole="button"
            accessibilityLabel="允许"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={onAllow}
            style={({ pressed }) => [
              styles.capsule,
              styles.flex,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.actionPrimary,
              },
              pressed && styles.allowPressed,
            ]}
          >
            {busy ? (
              <ActivityIndicator
                size="small"
                color={theme.colors.actionPrimaryText}
              />
            ) : (
              <AppText
                variant="body"
                color="actionPrimaryText"
                style={{
                  // 原型 conv-btn-floating-allow 字：13/600
                  fontSize: (theme.type.caption.fontSize ?? 12.5) + 0.5,
                  lineHeight: theme.type.footnote.lineHeight ?? 18,
                  fontWeight: '600',
                }}
              >
                允许
              </AppText>
            )}
          </Pressable>
        </View>
      ) : (
        <Pressable
          testID="approval-float-review"
          accessibilityRole="button"
          accessibilityLabel="查看并滑动确认"
          onPress={onReview}
          style={({ pressed }) => [
            styles.capsule,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.actionPrimary,
            },
            pressed && styles.allowPressed,
          ]}
        >
          <AppText
            variant="body"
            color="actionPrimaryText"
            style={{
              fontSize: (theme.type.caption.fontSize ?? 12.5) + 0.5,
              lineHeight: theme.type.footnote.lineHeight ?? 18,
              fontWeight: '600',
            }}
          >
            查看并滑动确认
          </AppText>
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  // 原型 conv-floating-title-group：点与标题间距 6
  titleRow: { gap: 6 },
  // 原型 conv-approval-floating-actions：按钮对间距 10
  actionsRow: { gap: 10 },
  flex: { flex: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  // 状态点（原型 6.5px）：尺寸定值，圆角走 pill（RN 钳制为正圆）
  dot: {
    width: 6.5,
    height: 6.5,
  },
  // 原型 conv-btn-floating-*：h38 胶囊
  capsule: {
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 原型 conv-btn-floating-allow:active：opacity 0.75
  allowPressed: { opacity: 0.75 },
});

export default ApprovalFloatCard;
