// 首页快速操作区（R2-05 部分 5：发起 run 快捷入口 + 最近会话快速选择）
//
// - 表单：单行 prompt 输入 + 「发起任务」按钮（空 prompt / 未连接 / busy 禁用，
//   回车提交 onSubmitEditing，R2UX 触控目标 ≥44）；
// - 最近会话快速选择：前 N 个最近活跃（store 排序不变量切片），chips 切换选中
//   （同 chip 再点取消 → 回到新会话）；选中后 runTask 带 sessionId 继续该会话；
// - 反馈：sending（菊花 + 文案）/ success（回执 runId + 「查看详情」跳 run 详情）/
//   error（错误码映射人话文案，M6 §11.3）；
// - 首帧预算：本区为静态表单 + 已水合 store 数据（无挂载期异步拉取），轻量渲染
//   不阻塞首帧（R2UX-05-10 首页口径）；未连接仅禁用+提示，不拉数据不阻塞。
//
// 组件契约（M4 §2.2.2）：vm 由页面注入（FileBrowser 同款），组件自身不订阅 store。
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { QuickRunVm } from '@/adapters/viewmodels/useQuickRunVm';
import { useTheme } from '@/adapters/platform/theme';

export interface QuickRunPanelProps {
  vm: QuickRunVm;
}

/** 会话标题兜底（title 缺省 → id，F5 SessionRow 同款展示口径） */
export function sessionTitleOf(title: string | undefined, id: string): string {
  return title && title.trim().length > 0 ? title : id;
}

/** 选中态判定（null = 新会话 chip；id 匹配 = 选中高亮） */
export function isChipSelected(
  selectedSessionId: string | null,
  sessionId: string | null
): boolean {
  return selectedSessionId === sessionId;
}

export function QuickRunPanel({ vm }: QuickRunPanelProps) {
  const theme = useTheme();

  const renderFeedback = () => {
    const feedback = vm.feedback;
    if (feedback.kind === 'sending') {
      return (
        <View style={styles.feedbackRow} testID="quickrun-feedback">
          <ActivityIndicator size="small" color={theme.textSecondary} />
          <Text style={[styles.feedbackText, { color: theme.textSecondary }]}>
            正在发起…
          </Text>
        </View>
      );
    }
    if (feedback.kind === 'success') {
      return (
        <View style={styles.feedbackRow} testID="quickrun-feedback">
          <Text style={[styles.successText, { color: theme.colorSuccess }]}>
            已发起 · run {feedback.runId}
          </Text>
          <Pressable
            testID="quickrun-open-run"
            accessibilityRole="button"
            accessibilityLabel={`查看 run ${feedback.runId} 详情`}
            onPress={() => router.push(`/run/${feedback.runId}`)}
            style={styles.openRunButton}
          >
            <Text style={[styles.openRunText, { color: theme.colorInfo }]}>
              查看详情
            </Text>
          </Pressable>
        </View>
      );
    }
    if (feedback.kind === 'error') {
      return (
        <View style={styles.feedbackRow} testID="quickrun-feedback">
          <Text style={[styles.errorText, { color: theme.colorError }]}>
            {feedback.message}
          </Text>
        </View>
      );
    }
    return null;
  };

  return (
    <View style={[styles.card, { backgroundColor: theme.bgCard }]}>
      <Text style={[styles.title, { color: theme.textPrimary }]}>快速操作</Text>
      {!vm.connected ? (
        <Text
          style={[styles.disconnectedHint, { color: theme.colorError }]}
          testID="quickrun-disconnected"
        >
          未连接，无法发起任务
        </Text>
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          testID="quickrun-input"
          style={[
            styles.input,
            {
              backgroundColor: theme.bgSecondary,
              color: theme.textPrimary,
              borderColor: theme.hairline,
            },
          ]}
          placeholder="输入任务描述，发起 run"
          placeholderTextColor={theme.textTertiary}
          value={vm.prompt}
          onChangeText={vm.setPrompt}
          editable={vm.connected && !vm.busy}
          returnKeyType="send"
          onSubmitEditing={vm.submit}
          maxLength={4096}
        />
        <Pressable
          testID="quickrun-submit"
          accessibilityRole="button"
          accessibilityLabel="发起任务"
          accessibilityState={{
            disabled: !vm.canSubmit,
            busy: vm.busy,
          }}
          disabled={!vm.canSubmit}
          onPress={vm.submit}
          style={({ pressed }) => [
            styles.submitButton,
            { backgroundColor: theme.colorSuccess },
            !vm.canSubmit && styles.submitDisabled,
            pressed && vm.canSubmit && styles.submitPressed,
          ]}
        >
          {vm.busy ? (
            <ActivityIndicator size="small" color={theme.textOnAccent} />
          ) : (
            <Text style={[styles.submitText, { color: theme.textOnAccent }]}>
              发起任务
            </Text>
          )}
        </Pressable>
      </View>

      {vm.recentSessions.length > 0 ? (
        <View style={styles.sessionSection}>
          <Text style={[styles.sessionLabel, { color: theme.textSecondary }]}>
            继续会话
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            <Pressable
              testID="quickrun-session-new"
              accessibilityRole="button"
              accessibilityLabel="新会话"
              accessibilityState={{ selected: vm.selectedSessionId === null }}
              onPress={() => vm.selectSession(null)}
              style={[
                styles.chip,
                { borderColor: theme.hairlineStrong },
                vm.selectedSessionId === null && {
                  backgroundColor: theme.colorSuccessBg,
                  borderColor: theme.colorSuccess,
                },
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: theme.textPrimary },
                  vm.selectedSessionId === null && {
                    color: theme.colorSuccess,
                  },
                ]}
              >
                新会话
              </Text>
            </Pressable>
            {vm.recentSessions.map((s) => {
              const selected = vm.selectedSessionId === s.id;
              return (
                <Pressable
                  key={s.id}
                  testID={`quickrun-session-${s.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`继续会话 ${sessionTitleOf(s.title, s.id)}`}
                  accessibilityState={{ selected }}
                  onPress={() => vm.selectSession(s.id)}
                  style={[
                    styles.chip,
                    { borderColor: theme.hairlineStrong },
                    selected && {
                      backgroundColor: theme.colorSuccessBg,
                      borderColor: theme.colorSuccess,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      { color: theme.textPrimary },
                      selected && { color: theme.colorSuccess },
                    ]}
                  >
                    {sessionTitleOf(s.title, s.id)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {renderFeedback()}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  disconnectedHint: {
    fontSize: 13,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  input: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  submitButton: {
    minHeight: 44,
    minWidth: 92,
    borderRadius: 9999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  submitDisabled: {
    opacity: 0.5,
  },
  submitPressed: {
    opacity: 0.85,
  },
  submitText: {
    fontSize: 14,
    fontWeight: '500',
  },
  sessionSection: {
    gap: 6,
  },
  sessionLabel: {
    fontSize: 12,
  },
  chipRow: {
    gap: 8,
    paddingVertical: 2,
  },
  chip: {
    minHeight: 36,
    borderRadius: 9999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 13,
  },
  feedbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 20,
  },
  feedbackText: {
    fontSize: 13,
  },
  successText: {
    fontSize: 13,
    flexShrink: 1,
  },
  errorText: {
    fontSize: 13,
  },
  openRunButton: {
    minHeight: 44,
    justifyContent: 'center',
  },
  openRunText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
