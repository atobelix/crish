// Toast 测试：显示消息。
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { Button, ToastProvider, useToast } from '@/presentation/ui';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

function Trigger() {
  const toast = useToast();
  return (
    <Button label="提示" onPress={() => toast.showToast('已保存', 'success')} />
  );
}

describe('Toast', () => {
  it('shows a message', async () => {
    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <Trigger />
        </ToastProvider>
      </SafeAreaProvider>
    );
    fireEvent.press(view.getByText('提示'));
    await waitFor(() => expect(view.getByText('已保存')).toBeTruthy());
  });
});
