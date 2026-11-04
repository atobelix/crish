import { act, fireEvent, render } from '@testing-library/react-native';
import { Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  MessageActionBar,
  AssistantMessageActionBar,
} from './MessageActionBar';
import type { MessageActionBarProps } from './MessageActionBar';
import * as clipboard from '@/adapters/platform/clipboard';
import { haptics } from '@/adapters/platform/haptics';
import { ToastProvider } from '@/presentation/ui';

jest.mock('@/adapters/platform/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    tap: jest.fn(),
    snap: jest.fn(),
    success: jest.fn(),
    failure: jest.fn(),
  },
}));

jest.mock('@/adapters/platform/clipboard', () => ({
  copyTextToClipboard: jest.fn(),
}));

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

async function renderBar(props: Partial<MessageActionBarProps> = {}) {
  return await render(
    <MessageActionBar
      messageId="msg-101"
      text="这是 AI 助手的回答内容"
      streaming={false}
      {...props}
    />,
    { wrapper: Wrapper }
  );
}

describe('MessageActionBar (移动端助手消息操作工具栏 - 纯图标精进版)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('导出别名与单例完整性一致', () => {
    expect(AssistantMessageActionBar).toBe(MessageActionBar);
  });

  describe('渲染守卫与纯图标化验证', () => {
    it('处于流式生成中（streaming === true）时不渲染工具栏', async () => {
      const view = await renderBar({ streaming: true });
      expect(view.queryByTestId('assistant-message-action-bar')).toBeNull();
    });

    it('正文为空或纯空白字符时不渲染工具栏', async () => {
      const view = await renderBar({ text: '' });
      expect(view.queryByTestId('assistant-message-action-bar')).toBeNull();

      await view.rerender(
        <Wrapper>
          <MessageActionBar
            messageId="msg-101"
            text={'   \n   \t '}
            streaming={false}
          />
        </Wrapper>
      );
      expect(view.queryByTestId('assistant-message-action-bar')).toBeNull();
    });

    it('收口且正文有效时正常渲染复制、分享、更多纯图标操作，且不渲染多余文字', async () => {
      const view = await renderBar();
      // 工具栏容器与各按钮存在
      expect(view.getByTestId('assistant-message-action-bar')).toBeTruthy();
      expect(
        view.getByTestId('assistant-message-action-bar-copy')
      ).toBeTruthy();
      expect(
        view.getByTestId('assistant-message-action-bar-share')
      ).toBeTruthy();
      expect(
        view.getByTestId('assistant-message-action-bar-more')
      ).toBeTruthy();

      // 无障碍标签语义健全
      expect(view.getByLabelText('复制正文')).toBeTruthy();
      expect(view.getByLabelText('分享回答')).toBeTruthy();
      expect(view.getByLabelText('更多操作')).toBeTruthy();

      // 纯图标化硬断言：界面上绝对不包含常驻的“复制”、“分享”字样
      expect(view.queryByText('复制')).toBeNull();
      expect(view.queryByText('分享')).toBeNull();
    });
  });

  describe('复制（Copy）纯图标链路与状态回弹', () => {
    it('点击复制触发触感振动、写入剪贴板，并在 1500ms 内展示已复制无障碍状态，超时自动恢复', async () => {
      jest.spyOn(clipboard, 'copyTextToClipboard').mockResolvedValue(true);

      const view = await renderBar({
        messageId: 'msg-copy-1',
        text: '待复制的正文',
      });

      const copyBtn = view.getByTestId('assistant-message-action-bar-copy');
      expect(view.getByLabelText('复制正文')).toBeTruthy();

      await act(async () => {
        fireEvent.press(copyBtn);
      });

      // 触感与剪贴板调用断言
      expect(haptics.selection).toHaveBeenCalledTimes(1);
      expect(clipboard.copyTextToClipboard).toHaveBeenCalledWith(
        '待复制的正文'
      );

      // 状态回弹为已复制（通过 accessibilityLabel 表达）
      expect(view.getByLabelText('已复制')).toBeTruthy();
      expect(view.queryByLabelText('复制正文')).toBeNull();

      // 1500ms 定时器超时后自动恢复为原样
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
      expect(view.getByLabelText('复制正文')).toBeTruthy();
      expect(view.queryByLabelText('已复制')).toBeNull();

      // 推进时间让 Toast 正常收起，避免跨用例定时器残留
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
    });

    it('写入剪贴板失败时保持原样并提示失败', async () => {
      jest.spyOn(clipboard, 'copyTextToClipboard').mockResolvedValue(false);

      const view = await renderBar({
        messageId: 'msg-copy-fail',
        text: '失败正文',
      });

      const copyBtn = view.getByTestId('assistant-message-action-bar-copy');
      await act(async () => {
        fireEvent.press(copyBtn);
      });

      expect(haptics.selection).toHaveBeenCalledTimes(1);
      expect(view.getByLabelText('复制正文')).toBeTruthy();
      expect(view.queryByLabelText('已复制')).toBeNull();
    });
  });

  describe('分享（Share）纯图标链路', () => {
    it('点击分享按钮触发触感并调用系统原生 Share.share', async () => {
      const shareSpy = jest
        .spyOn(Share, 'share')
        .mockResolvedValue({ action: 'sharedAction' });

      const view = await renderBar({ text: '分享测试内容' });

      const shareBtn = view.getByTestId('assistant-message-action-bar-share');
      await act(async () => {
        fireEvent.press(shareBtn);
      });

      expect(haptics.selection).toHaveBeenCalledTimes(1);
      expect(shareSpy).toHaveBeenCalledWith({ message: '分享测试内容' });
    });

    it('系统分享异常或取消时静默处理不抛错冒泡', async () => {
      jest.spyOn(Share, 'share').mockRejectedValue(new Error('User cancelled'));

      const view = await renderBar({ text: '异常分享' });

      const shareBtn = view.getByTestId('assistant-message-action-bar-share');
      await expect(
        act(async () => {
          fireEvent.press(shareBtn);
        })
      ).resolves.not.toThrow();
    });
  });

  describe('更多（More）与防误触重新生成二级防护链路', () => {
    it('点击更多唤起下拉菜单，点击重新生成呼出二次确认弹窗并阻断误触，确认后触发回调', async () => {
      const onRegenerate = jest.fn();

      const view = await renderBar({
        messageId: 'msg-regen-123',
        text: '这是待重新生成的回答',
        onRegenerate,
      });

      // 1. 点击更多按钮（···）展开下拉菜单
      const moreBtn = view.getByTestId('assistant-message-action-bar-more');
      await act(async () => {
        fireEvent.press(moreBtn);
      });
      expect(haptics.selection).toHaveBeenCalledTimes(1);

      // 下拉菜单内呈现“重新生成回答”
      expect(view.getByText('重新生成回答')).toBeTruthy();

      // 2. 点击菜单项“重新生成回答”
      await act(async () => {
        fireEvent.press(view.getByText('重新生成回答'));
      });

      // 防误触一级隔离：此时仅弹出确认 Dialog，尚未执行 onRegenerate
      expect(view.getByText('重新生成回答？')).toBeTruthy();
      expect(view.getByText(/确认重新生成此回答？/)).toBeTruthy();
      expect(onRegenerate).not.toHaveBeenCalled();

      // 3. 防误触二级隔离：用户点击取消 -> 弹窗关闭，依然零调用
      const cancelBtn = view.getByTestId(
        'assistant-message-action-bar-confirm-cancel'
      );
      await act(async () => {
        fireEvent.press(cancelBtn);
      });
      expect(onRegenerate).not.toHaveBeenCalled();

      // 4. 再次呼出并点击二次确认 -> 真正执行重新生成回调
      await act(async () => {
        fireEvent.press(moreBtn);
      });
      await act(async () => {
        fireEvent.press(view.getByText('重新生成回答'));
      });

      const submitBtn = view.getByTestId(
        'assistant-message-action-bar-confirm-submit'
      );
      await act(async () => {
        fireEvent.press(submitBtn);
      });

      expect(haptics.tap).toHaveBeenCalledTimes(1);
      expect(onRegenerate).toHaveBeenCalledTimes(1);
      expect(onRegenerate).toHaveBeenCalledWith('msg-regen-123');
    });

    it('当 canRegenerate === false 时，重新生成条目呈现提示且不唤起确认弹窗', async () => {
      const onRegenerate = jest.fn();

      const view = await renderBar({
        messageId: 'msg-disabled',
        canRegenerate: false,
        onRegenerate,
      });

      // 展开菜单
      await act(async () => {
        fireEvent.press(view.getByTestId('assistant-message-action-bar-more'));
      });
      expect(view.getByText('重新生成回答')).toBeTruthy();
      expect(view.getByText('当前正在生成中')).toBeTruthy();

      // 点击禁用项
      await act(async () => {
        fireEvent.press(view.getByText('重新生成回答'));
      });

      // 不唤起确认弹窗，也不触发回调
      expect(view.queryByText('重新生成回答？')).toBeNull();
      expect(onRegenerate).not.toHaveBeenCalled();
    });
  });

  describe('独立宿主兼容性', () => {
    it('在未包裹 ToastProvider 的极简宿主中亦能正常渲染和操作且不崩溃', async () => {
      jest.spyOn(clipboard, 'copyTextToClipboard').mockResolvedValue(true);

      const view = await render(
        <MessageActionBar
          messageId="msg-standalone"
          text="无 ToastProvider 宿主"
          streaming={false}
        />
      );

      const copyBtn = view.getByTestId('assistant-message-action-bar-copy');
      await act(async () => {
        fireEvent.press(copyBtn);
      });

      expect(view.getByLabelText('已复制')).toBeTruthy();
    });
  });
});
