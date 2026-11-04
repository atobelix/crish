// ConversationScreen 引擎槽位呈现（U2）：宿主只按能力面渲染——
// - error 槽：message + detail 常驻错误条全量消费，onDismiss 在场
//   才有关闭；只有 message（远端形态）时退化为单行、无关闭；
// - stop 槽：busy 且引擎声明 stop 才出停止 pill；
// - 空态：emptyState 的 actionLabel / onAction 落为按钮。
// 末尾另辖点外失焦接线（2026-11-03 同簇工单）：点时间线收键盘、
// 点 Composer 子树不经时间线收键盘路径。
import { Keyboard } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { ToastProvider } from '@/presentation/ui';
import type { ConversationEngine } from '@/adapters/conversation/types';
import { ConversationScreen } from './sessionDetailScreen';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function fakeEngine(
  overrides: Partial<ConversationEngine> = {}
): ConversationEngine {
  return {
    kind: 'local',
    id: 't-1',
    title: '测试线程',
    blocks: [],
    busy: false,
    available: true,
    error: null,
    composer: {
      prompt: '',
      setPrompt: () => {},
      submit: () => {},
      submitText: () => Promise.resolve(true),
      canSubmit: false,
      editable: true,
      locked: false,
      placeholder: '发消息…',
      modelControl: { label: '供应商 · 模型', onPress: () => {} },
      onAttachPress: () => {},
      hasAttachments: false,
    },
    menuEntries: [],
    emptyState: { title: '暂无消息' },
    renderSheets: () => null,
    ...overrides,
  };
}

async function renderScreen(engine: ConversationEngine) {
  return await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>
        <ConversationScreen engine={engine} follow onFollowChange={() => {}} />
      </ToastProvider>
    </SafeAreaProvider>
  );
}

describe('ConversationScreen · 引擎槽位（U2）', () => {
  it('error 槽：message + detail 全量呈现，关闭走 onDismiss', async () => {
    const onDismiss = jest.fn();
    await renderScreen(
      fakeEngine({
        error: {
          message: '鉴权失败：API Key 无效或无权限，请检查供应商配置。',
          detail: 'Incorrect API key provided',
          onDismiss,
        },
      })
    );
    expect(screen.getByTestId('session-error')).toBeTruthy();
    expect(screen.getByText(/鉴权失败/)).toBeTruthy();
    expect(screen.getByText(/Incorrect API key/)).toBeTruthy();
    await fireEvent.press(screen.getByText('关闭'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('error 槽：只有 message（远端形态）时无关闭行', async () => {
    await renderScreen(fakeEngine({ error: { message: '发送失败' } }));
    expect(screen.getByTestId('session-error')).toBeTruthy();
    expect(screen.getByText('发送失败')).toBeTruthy();
    expect(screen.queryByText('关闭')).toBeNull();
  });

  it('stop 槽：busy + 声明 stop 才出 pill，按压走引擎 stop', async () => {
    const stop = jest.fn();
    await renderScreen(fakeEngine({ busy: true, stop }));
    const pill = screen.getByTestId('session-stop');
    expect(pill).toBeTruthy();
    await fireEvent.press(pill);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stop 槽：未声明 stop 的忙态引擎不渲染 pill（不造假钮）', async () => {
    await renderScreen(fakeEngine({ busy: true }));
    expect(screen.queryByTestId('session-stop')).toBeNull();
  });

  it('空态：emptyState 动作落为按钮并走 onAction', async () => {
    const onAction = jest.fn();
    await renderScreen(
      fakeEngine({
        emptyState: {
          title: '尚未配置本地供应商',
          actionLabel: '去配置供应商',
          onAction,
        },
      })
    );
    expect(screen.getByText('尚未配置本地供应商')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('session-empty-action'));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('ConversationScreen · 点外失焦（2026-11-03）', () => {
  it('点时间线内容区 → 收键盘（输入框失焦）', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      await renderScreen(fakeEngine());
      await fireEvent(screen.getByTestId('session-timeline'), 'touchStart');
      expect(dismiss).toHaveBeenCalledTimes(1);
    } finally {
      dismiss.mockRestore();
    }
  });

  it('点 Composer 输入框本体 → 不经时间线路径收键盘（输入区是兄弟浮层）', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    try {
      await renderScreen(fakeEngine());
      await fireEvent(screen.getByTestId('session-composer'), 'touchStart');
      expect(dismiss).not.toHaveBeenCalled();
    } finally {
      dismiss.mockRestore();
    }
  });
});

describe('ConversationScreen · 宏观环境遮蔽大软阴影（方案 24 钉案）', () => {
  it('composerArea 装配 ComposerAmbientVeil 且位于 KeyboardStickyView 首个子节点（最底层）', async () => {
    const view = await renderScreen(fakeEngine());
    const veil = view.getByTestId('composer-ambient-veil', {
      includeHiddenElements: true,
    });
    const composer = view.getByTestId('session-composer');

    expect(veil).toBeTruthy();
    expect(composer).toBeTruthy();

    // 验证在 KeyboardStickyView 容器中的首位层级：veil 为首个子节点，处于最底层
    const stickyContainer = veil.parent;
    expect(stickyContainer).toBeTruthy();
    expect(stickyContainer?.children[0]).toBe(veil);
  });
});
