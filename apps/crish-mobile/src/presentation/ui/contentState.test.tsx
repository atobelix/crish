// 三态家族（批 A）：LoadingState / ErrorState 的出口契约——
// 加载必有状态文案（不用骨架屏）、失败必带可点的重试出路。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import { ErrorState, LoadingState } from '@/presentation/ui';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

async function renderWithProviders(element: ReactElement) {
  return await render(element, { wrapper: Providers });
}

describe('LoadingState', () => {
  it('缺省呈现「加载中…」状态文案（Spinner 在场由组件构造保证）', async () => {
    const view = await renderWithProviders(<LoadingState />);
    expect(view.getByText('加载中…')).toBeTruthy();
    // 注：本版 RNTL 无按类型查复合组件的公开查询，指示器在场不在此
    // 间接断言——LoadingState 源码恒渲染共享 Spinner，Spinner 本身
    // 由 uiPrimitives 等套件覆盖。
  });

  it('可自定义文案', async () => {
    const view = await renderWithProviders(
      <LoadingState label="正在加载模型…" />
    );
    expect(view.getByText('正在加载模型…')).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('呈现标题 + 详情，点重试触发 onRetry（失败必带出路）', async () => {
    const onRetry = jest.fn();
    const view = await renderWithProviders(
      <ErrorState
        title="无法获取模型列表"
        detail="cmd.timeout"
        onRetry={onRetry}
      />
    );
    expect(view.getByText('无法获取模型列表')).toBeTruthy();
    expect(view.getByText('cmd.timeout')).toBeTruthy();
    await fireEvent.press(view.getByText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
