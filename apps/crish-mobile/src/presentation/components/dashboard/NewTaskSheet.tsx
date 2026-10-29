// 发起任务 Sheet：输入任务 + 选择会话（新会话 / 最近会话），提交 runTask。
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useQuickRunVm } from '@/adapters/viewmodels/useQuickRunVm';
import { AppText, Button, Input, Sheet } from '@/presentation/ui';

export interface NewTaskSheetProps {
  visible: boolean;
  onClose: () => void;
  onOpenRun: (runId: string) => void;
}

export function NewTaskSheet({
  visible,
  onClose,
  onOpenRun,
}: NewTaskSheetProps) {
  const theme = useTheme();
  const vm = useQuickRunVm();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (vm.feedback.kind === 'success') {
      onOpenRun(vm.feedback.runId);
      onClose();
    } else if (vm.feedback.kind === 'error') {
      setError(vm.feedback.message);
    } else {
      setError(null);
    }
  }, [vm.feedback, onOpenRun, onClose]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="发起任务"
      testID="new-task-sheet"
      footer={
        <Button
          label="发送"
          icon="send"
          onPress={vm.submit}
          disabled={!vm.canSubmit}
          loading={vm.busy}
          testID="new-task-submit"
        />
      }
    >
      <Input
        testID="new-task-input"
        placeholder="描述你想让 Agent 完成的任务"
        value={vm.prompt}
        onChangeText={vm.setPrompt}
        multiline
        autoFocus
        maxLength={4096}
        style={styles.input}
      />
      {error ? (
        <AppText variant="meta" color="danger" style={styles.error}>
          {error}
        </AppText>
      ) : null}
      {vm.recentSessions.length > 0 ? (
        <View style={styles.section}>
          <AppText variant="caption" color="textTertiary">
            在会话中继续
          </AppText>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            <SessionChip
              label="新会话"
              active={vm.selectedSessionId === null}
              onPress={() => vm.selectSession(null)}
            />
            {vm.recentSessions.map((session) => (
              <SessionChip
                key={session.id}
                label={session.title?.trim() || '未命名会话'}
                active={vm.selectedSessionId === session.id}
                onPress={() => vm.selectSession(session.id)}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}
      <View style={{ height: theme.space.sm }} />
    </Sheet>
  );
}

function SessionChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: active
            ? theme.colors.accentSoft
            : theme.colors.surfaceSubtle,
          borderColor: active ? theme.colors.accent : 'transparent',
        },
        pressed && { opacity: 0.75 },
      ]}
    >
      <AppText
        variant="meta"
        color={active ? 'textPrimary' : 'textSecondary'}
        numberOfLines={1}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 96,
  },
  error: {
    marginTop: 8,
  },
  section: {
    marginTop: 20,
    gap: 10,
  },
  chips: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  chip: {
    minHeight: 36,
    maxWidth: 180,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default NewTaskSheet;
