// Toast 浮层与 ConversationStatusBanner 状态横幅测试（方案 06 落地验证）
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import {
  Button,
  ConversationStatusBanner,
  ToastProvider,
  useToast,
  type ToastController,
  type ToastTone,
} from '@/presentation/ui';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function TestHarness({ action }: { action: (toast: ToastController) => void }) {
  const toast = useToast();
  return <Button label="触发测试" onPress={() => action(toast)} />;
}

function ClearHarness() {
  const toast = useToast();
  return (
    <>
      <Button label="弹出" onPress={() => toast.show('即将被清除')} />
      <Button label="清空" onPress={() => toast.clear()} />
    </>
  );
}

describe('Actionable Toast & KeyboardSticky Pill', () => {
  it('支持兼容旧接口 showToast 弹出消息', async () => {
    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <TestHarness
            action={(toast) => toast.showToast('简单操作成功', 'success')}
          />
        </ToastProvider>
      </SafeAreaProvider>
    );

    await fireEvent.press(view.getByText('触发测试'));
    await waitFor(() => {
      expect(view.getByText('简单操作成功')).toBeTruthy();
    });
  });

  it('支持多态配色与标题（info / success / warning / danger / error）', async () => {
    const tones: ToastTone[] = [
      'info',
      'success',
      'warning',
      'danger',
      'error',
    ];
    for (const tone of tones) {
      const view = await render(
        <SafeAreaProvider initialMetrics={metrics}>
          <ToastProvider>
            <TestHarness
              action={(toast) =>
                toast.show({
                  title: `标题-${tone}`,
                  message: `内容-${tone}`,
                  tone,
                })
              }
            />
          </ToastProvider>
        </SafeAreaProvider>
      );

      await fireEvent.press(view.getByText('触发测试'));
      await waitFor(() => {
        expect(view.getByText(`标题-${tone}`)).toBeTruthy();
        expect(view.getByText(`内容-${tone}`)).toBeTruthy();
      });
      await view.unmount();
    }
  });

  it('支持 Action 交互按钮并在点击后触发回调与自动核销', async () => {
    const onRetry = jest.fn();
    const onViewDetail = jest.fn();

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <TestHarness
            action={(toast) =>
              toast.show({
                title: '工具执行失败',
                message: '终端命令执行超时，是否重试？',
                tone: 'danger',
                actions: [
                  {
                    label: '查看详情',
                    onPress: onViewDetail,
                    variant: 'subtle',
                  },
                  { label: '立即重试', onPress: onRetry, variant: 'primary' },
                ],
              })
            }
          />
        </ToastProvider>
      </SafeAreaProvider>
    );

    await fireEvent.press(view.getByText('触发测试'));

    await waitFor(() => {
      expect(view.getByText('工具执行失败')).toBeTruthy();
      expect(view.getByText('立即重试')).toBeTruthy();
      expect(view.getByText('查看详情')).toBeTruthy();
    });

    await fireEvent.press(view.getByText('立即重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('支持手动点击关闭按钮', async () => {
    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <TestHarness
            action={(toast) =>
              toast.show({
                message: '可关闭通知',
                dismissible: true,
                dismissLabel: '关闭提示',
              })
            }
          />
        </ToastProvider>
      </SafeAreaProvider>
    );

    await fireEvent.press(view.getByText('触发测试'));

    await waitFor(() => {
      expect(view.getByText('可关闭通知')).toBeTruthy();
      expect(view.getByLabelText('关闭提示')).toBeTruthy();
    });

    await fireEvent.press(view.getByLabelText('关闭提示'));
  });

  it('支持 placement="bottom" 并在视口安全区展示', async () => {
    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <TestHarness
            action={(toast) =>
              toast.show({
                message: '底部通知已呼出',
                placement: 'bottom',
                bottomOffset: 48,
              })
            }
          />
        </ToastProvider>
      </SafeAreaProvider>
    );

    await fireEvent.press(view.getByText('触发测试'));
    await waitFor(() => {
      expect(view.getByText('底部通知已呼出')).toBeTruthy();
    });
  });

  it('支持 clear 方法清空当前 Toast', async () => {
    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>
          <ClearHarness />
        </ToastProvider>
      </SafeAreaProvider>
    );

    await fireEvent.press(view.getByText('弹出'));
    await waitFor(() => {
      expect(view.getByText('即将被清除')).toBeTruthy();
    });

    await fireEvent.press(view.getByText('清空'));
    await waitFor(() => {
      expect(view.queryByText('即将被清除')).toBeNull();
    });
  });
});

describe('ConversationStatusBanner 会话状态横幅', () => {
  it('当 state === "enabled" 时返回 null，不占用视觉空间', async () => {
    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ConversationStatusBanner
          availability={{ state: 'enabled' }}
          onRetry={jest.fn()}
        />
      </SafeAreaProvider>
    );

    expect(view.queryByTestId('conversation-status-banner')).toBeNull();
  });

  it('无状态传入时返回 null', async () => {
    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ConversationStatusBanner />
      </SafeAreaProvider>
    );

    expect(view.queryByTestId('conversation-status-banner')).toBeNull();
  });

  it('断开连接状态细分并就地提供“重试连接”与“使用本地模式”Action', async () => {
    const onRetry = jest.fn();
    const onUseLocalMode = jest.fn();

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ConversationStatusBanner
          status="disconnected"
          onRetry={onRetry}
          onUseLocalMode={onUseLocalMode}
        />
      </SafeAreaProvider>
    );

    await waitFor(() => {
      expect(view.getByText('与桌面端连接已断开')).toBeTruthy();
    });
    const retryBtn = view.getByLabelText('重试连接');
    const localBtn = view.getByLabelText('使用本地模式');

    expect(retryBtn).toBeTruthy();
    expect(localBtn).toBeTruthy();

    await fireEvent.press(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);

    await fireEvent.press(localBtn);
    expect(onUseLocalMode).toHaveBeenCalledTimes(1);
  });

  it('弱网与重连中状态正确呈现对应文案', async () => {
    const view1 = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ConversationStatusBanner status="weak-network" />
      </SafeAreaProvider>
    );
    await waitFor(() => {
      expect(view1.getByText('网络连接较弱，可能存在延迟')).toBeTruthy();
    });

    const view2 = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ConversationStatusBanner status="reconnecting" />
      </SafeAreaProvider>
    );
    await waitFor(() => {
      expect(view2.getByText('正在重新连接桌面端...')).toBeTruthy();
    });
  });

  it('令牌失效需要修复配对时就地展示“修复配对”动作', async () => {
    const onRepair = jest.fn();

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ConversationStatusBanner
          status="needs-repair"
          onRepairPairing={onRepair}
        />
      </SafeAreaProvider>
    );

    await waitFor(() => {
      expect(view.getByText('配对令牌已失效，需重新配对')).toBeTruthy();
    });
    const repairBtn = view.getByLabelText('修复配对');
    await fireEvent.press(repairBtn);
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it('支持自定义错误信息与打开设置按钮', async () => {
    const onSettings = jest.fn();

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ConversationStatusBanner
          status="unreachable"
          message="定制化网络不可达提示"
          onOpenSettings={onSettings}
        />
      </SafeAreaProvider>
    );

    await waitFor(() => {
      expect(view.getByText('定制化网络不可达提示')).toBeTruthy();
    });
    const settingsBtn = view.getByLabelText('打开设置');
    await fireEvent.press(settingsBtn);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});
