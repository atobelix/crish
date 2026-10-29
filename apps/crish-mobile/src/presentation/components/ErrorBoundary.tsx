// 根级错误边界：渲染异常时给出可恢复的兜底界面，避免整屏白屏。
import { Component, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Button } from '@/presentation/ui';

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.warn(
      `[error-boundary] ${error.message}${info.componentStack ?? ''}`
    );
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return <ErrorFallback onRetry={this.reset} />;
    }
    return this.props.children;
  }
}

function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.canvas }]}>
      <AppText variant="title2">应用遇到问题</AppText>
      <AppText variant="footnote" color="textSecondary" style={styles.hint}>
        请重试；若持续出现，请重新打开应用。
      </AppText>
      <Button
        label="重试"
        variant="secondary"
        onPress={onRetry}
        style={styles.action}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 10,
  },
  hint: {
    textAlign: 'center',
  },
  action: {
    marginTop: 8,
    minWidth: 120,
  },
});

export default ErrorBoundary;
