// 三态组件家族（批 A，2026-11-03；核查 06-1 的收编落点）：
// 列表/面板类表面的「加载 / 失败 / 为空」只许走本家族三个出口，不再
// 各屏手搓居中 View + 裸 Spinner + 自由文案：
//   - 空态 = EmptyState（ui/EmptyState.tsx，本家族成员，本文件不重造）；
//   - 加载 = LoadingState：Spinner + 状态文案（明文口径：不用骨架屏，
//     骨架屏已经用户裁决排除；无文案的裸转圈不构成反馈）；
//   - 失败 = ErrorState：标题（+可选详情行）+ **必带重试**——onRetry
//     是必填 prop，类型上就不许出现「只报错、无出路」的失败面。
// 几何与 EmptyState 同制：居中列、默认 paddingVertical 64；Sheet 内
// 等短容器用 compact（32，与各 Sheet 旧手搓 center 几何同值，收编
// 视觉中性）。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Button from './Button';
import Spinner from './Spinner';

export interface LoadingStateProps {
  /** 状态文案（缺省「加载中…」） */
  label?: string;
  /** Sheet 内短容器形态（paddingVertical 32） */
  compact?: boolean;
  testID?: string;
}

export function LoadingState({
  label = '加载中…',
  compact = false,
  testID,
}: LoadingStateProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          paddingVertical: compact ? 32 : 64,
          gap: theme.space.md,
        },
      ]}
    >
      <Spinner />
      <AppText variant="footnote" color="textTertiary" style={styles.text}>
        {label}
      </AppText>
    </View>
  );
}

export interface ErrorStateProps {
  title: string;
  /** 详情行（错误码/原因的人话补充；原始错误串不进此面，只进详情） */
  detail?: string;
  /** 必填：失败面必须给出重试出路 */
  onRetry: () => void;
  retryLabel?: string;
  /** Sheet 内短容器形态（paddingVertical 32） */
  compact?: boolean;
  testID?: string;
}

export function ErrorState({
  title,
  detail,
  onRetry,
  retryLabel = '重试',
  compact = false,
  testID,
}: ErrorStateProps) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          paddingVertical: compact ? 32 : 64,
          gap: theme.space.md,
        },
      ]}
    >
      <AppText variant="body" color="textSecondary" style={styles.text}>
        {title}
      </AppText>
      {detail ? (
        <AppText variant="caption" color="textTertiary" style={styles.text}>
          {detail}
        </AppText>
      ) : null}
      <Button label={retryLabel} variant="secondary" onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  text: {
    textAlign: 'center',
  },
});
