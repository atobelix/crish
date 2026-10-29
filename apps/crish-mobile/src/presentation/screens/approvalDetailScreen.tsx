// 审批弹窗：以底部卡片覆盖当前页面，完成允许 / 拒绝决策。
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useApprovalDetailVm } from '@/adapters/viewmodels/useApprovalDetailVm';
import { useSessionStore } from '@/adapters/hooks/useAppStore';
import {
  AppText,
  Button,
  EmptyState,
  Icon,
  IconButton,
  useToast,
} from '@/presentation/ui';
import ApprovalCard from '@/presentation/components/blocks/ApprovalCard';
import ApprovalActionBar from '@/presentation/components/blocks/ApprovalActionBar';

export interface ApprovalDetailScreenProps {
  toolCallId: string;
  onBack: () => void;
}

const DECISION_TEXT = {
  approved: '已允许',
  denied: '已拒绝',
  expired: '已过期',
} as const;

export default function ApprovalDetailScreen({
  toolCallId,
  onBack,
}: ApprovalDetailScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const vm = useApprovalDetailVm(toolCallId);
  const sessionTitle = useSessionStore(
    (s) =>
      s.sessions.find((session) => session.id === vm.item?.request.sessionId)
        ?.title ?? null
  );
  const isMainAgent = vm.item?.arbiter === 'main-agent';
  const showActions =
    !isMainAgent &&
    vm.item !== null &&
    (vm.item.status === 'pending' ||
      vm.item.status === 'deciding' ||
      vm.item.status === 'queued');

  const handleAllow = () => {
    vm.onAllow();
    toast.showToast('已提交允许', 'success');
  };
  const handleDeny = () => {
    vm.onDeny();
    toast.showToast('已提交拒绝', 'info');
  };

  return (
    <View style={styles.overlay}>
      <Pressable
        testID="approval-scrim"
        accessibilityRole="button"
        accessibilityLabel="关闭审批"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.scrim },
        ]}
        onPress={onBack}
      />
      <View
        style={[
          styles.sheet,
          {
            borderTopLeftRadius: theme.radius.sheet,
            borderTopRightRadius: theme.radius.sheet,
            backgroundColor: theme.colors.surfaceRaised,
            borderColor: theme.colors.hairline,
            paddingBottom: Math.max(insets.bottom, theme.space.md),
          },
        ]}
      >
        <View
          style={[
            styles.handle,
            {
              width: theme.size.sheetHandleWidth,
              height: theme.size.sheetHandleHeight,
              marginTop: theme.space.sm,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.borderStrong,
            },
          ]}
        />
        <View style={styles.header}>
          <AppText variant="title2" style={styles.headerTitle}>
            审批
          </AppText>
          <IconButton
            name="x"
            accessibilityLabel="关闭"
            onPress={onBack}
            testID="approval-close"
          />
        </View>

        {vm.item ? (
          <>
            <ScrollView contentContainerStyle={styles.content}>
              {sessionTitle ? (
                <AppText variant="footnote" color="textTertiary">
                  {sessionTitle}
                </AppText>
              ) : null}
              <ApprovalCard item={vm.item} remainingMs={vm.remainingMs} />
              {isMainAgent ? (
                <View style={styles.note}>
                  <Icon
                    name="info"
                    size={14}
                    color={theme.colors.textTertiary}
                  />
                  <AppText variant="footnote" color="textTertiary">
                    该请求由桌面端自动裁决
                  </AppText>
                </View>
              ) : null}
            </ScrollView>
            {showActions ? (
              <ApprovalActionBar
                busy={vm.busy}
                onAllow={handleAllow}
                onDeny={handleDeny}
                toolName={vm.item.request.toolName}
                dangerLevel={vm.item.dangerLevel}
                embedded
              />
            ) : null}
          </>
        ) : vm.historyResult ? (
          <EmptyState
            icon={
              vm.historyResult.decision === 'approved'
                ? 'check-circle'
                : vm.historyResult.decision === 'denied'
                  ? 'x'
                  : 'clock'
            }
            title={DECISION_TEXT[vm.historyResult.decision]}
            action={
              <Button label="关闭" variant="secondary" onPress={onBack} />
            }
          />
        ) : (
          <EmptyState
            icon="alert-circle"
            title="请求不存在或已过期"
            action={
              <Button label="关闭" variant="secondary" onPress={onBack} />
            }
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopWidth: StyleSheet.hairlineWidth,
    maxHeight: '92%',
  },
  handle: {
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 20,
    paddingRight: 8,
    minHeight: 52,
  },
  headerTitle: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    gap: 14,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 2,
  },
});
