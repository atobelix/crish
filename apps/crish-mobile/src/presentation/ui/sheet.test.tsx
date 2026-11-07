// Sheet 键盘瞬发交接与即时呈现回归网（2026-11-04 动效重构，深治方案 01-1）：
// 彻底废除 SHEET_KEYBOARD_HANDOFF_TIMEOUT_MS = 1000 阻塞门与串行等待；
// 呈现请求到达时内容同帧立即可达（零毫秒阻塞）；visible=false 时内容不挂载。
// 批 D 追加：语义档位、dismissible=false 诚实口径、backAction 钻取
// 返回分发、搜索升档、关闭末帧冻结；防瞬移初始估高平滑度。
import { act, fireEvent, render } from '@testing-library/react-native';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import {
  AppText,
  nextSheetSize,
  SHEET_SIZE_RATIOS,
  sheetFingerVisualDelta,
  sheetGestureProgress,
  sheetGestureVelocity,
  sheetPanelTranslateY,
  Sheet,
  SheetOptionRow,
  useOverlayHost,
  useSheetSearchRaise,
} from '@/presentation/ui';
import { handleOverlayBack } from '@/presentation/ui/overlayStack';

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

describe('Sheet 键盘瞬发交接与即时呈现', () => {
  it('visible 时内容即刻呈现（零毫秒阻塞门，无需等待键盘归零或 1000ms 超时）', async () => {
    const view = await renderWithProviders(
      <Sheet keyboard="none"
        visible
        onClose={() => undefined}
        title="瞬时呈现测试"
        testID="sheet-under-test"
      >
        <AppText>面板内容立即就绪</AppText>
      </Sheet>
    );
    expect(view.getByTestId('sheet-under-test')).toBeTruthy();
    expect(view.getByText('面板内容立即就绪')).toBeTruthy();
  });

  it('visible=false 时不挂载内容', async () => {
    const view = await renderWithProviders(
      <Sheet keyboard="none" visible={false} onClose={() => undefined} testID="sheet-hidden">
        <AppText>不应出现</AppText>
      </Sheet>
    );
    expect(view.queryByTestId('sheet-hidden')).toBeNull();
    expect(view.queryByText('不应出现')).toBeNull();
  });
});

describe('Sheet 行程与手指位移', () => {
  it('未测得行程时位移为 0，不用档位比例冒充', () => {
    expect(sheetPanelTranslateY(0, 0)).toBe(0);
    expect(sheetPanelTranslateY(0.5, 0)).toBe(0);
    expect(sheetPanelTranslateY(1, 0)).toBe(0);
  });

  it('fallback 680、实测 240 时手指 10dp 视觉也是 10dp', () => {
    const staleFallback = 680;
    const actual = 240;
    const finger = 10;
    expect(sheetFingerVisualDelta(1, finger, actual)).toBeCloseTo(finger);
    const oldVisual = finger * (staleFallback / actual);
    expect(oldVisual).toBeCloseTo(28.333, 2);
    expect(sheetFingerVisualDelta(1, finger, actual)).not.toBeCloseTo(oldVisual);
    expect(sheetGestureProgress(1, finger, actual)).toBeCloseTo(1 - finger / actual);
    expect(sheetGestureVelocity(finger, actual)).toBeCloseTo(-finger / actual);
  });
});

/** 面板宿主的 maxHeight（style 数组拍平后取） */
function panelMaxHeight(
  view: { getByTestId: (id: string) => { props: Record<string, unknown> } },
  id: string
) {
  const style = view.getByTestId(id).props.style as unknown;
  const flat: Record<string, unknown>[] = [];
  const walk = (entry: unknown) => {
    if (Array.isArray(entry)) entry.forEach(walk);
    else if (entry && typeof entry === 'object')
      flat.push(entry as Record<string, unknown>);
  };
  walk(style);
  return flat.find((s) => 'maxHeight' in s)?.maxHeight;
}

/**
 * 模拟系统返回键：生产路径 = 根布局 useOverlayBackHandler 把硬件
 * 返回交给注册表分发函数裁决（栈顶优先/钻取优先/不可关挡下）；
 * jest 环境的 BackHandler 事件不穿透（实测 emit 无效），故直调
 * 分发函数验 Sheet 登记与裁决的端到端行为。Modal 自身的
 * onRequestClose 兜底走同一分发（handleOverlayBackFor），其栈
 * 裁决细则由 overlayStack.test 覆盖。
 */
function pressSystemBack() {
  handleOverlayBack();
}

describe('Sheet 语义档位（批 D）', () => {
  it('档位比例正典与升档序', () => {
    expect(SHEET_SIZE_RATIOS).toEqual({
      compact: 0.4,
      medium: 0.6,
      large: 0.8,
      full: 1,
    });
    expect(nextSheetSize('compact')).toBe('medium');
    expect(nextSheetSize('medium')).toBe('large');
    expect(nextSheetSize('large')).toBe('full');
    expect(nextSheetSize('full')).toBe('full');
  });

  it('size 决定面板高度上限；缺省 = large', async () => {
    const compact = await renderWithProviders(
      <Sheet keyboard="none"
        visible
        onClose={() => undefined}
        size="compact"
        testID="sheet-compact"
      >
        <AppText>短内容</AppText>
      </Sheet>
    );
    expect(panelMaxHeight(compact, 'sheet-compact')).toBe('40%');
    const fallback = await renderWithProviders(
      <Sheet keyboard="none" visible onClose={() => undefined} testID="sheet-default-size">
        <AppText>默认档</AppText>
      </Sheet>
    );
    expect(panelMaxHeight(fallback, 'sheet-default-size')).toBe('80%');
  });

  it('搜索获焦升一档、失焦回落（useSheetSearchRaise）', async () => {
    function SearchProbe() {
      const raise = useSheetSearchRaise();
      return (
        <TextInput
          testID="sheet-search-probe"
          onFocus={raise.onFocus}
          onBlur={raise.onBlur}
        />
      );
    }
    const view = await renderWithProviders(
      <Sheet keyboard="none"
        visible
        onClose={() => undefined}
        size="large"
        testID="sheet-raise"
      >
        <SearchProbe />
      </Sheet>
    );
    expect(panelMaxHeight(view, 'sheet-raise')).toBe('80%');
    // fireEvent 须 await：其 act 落帧后升档状态才回到 Sheet 本体
    await fireEvent(view.getByTestId('sheet-search-probe'), 'focus');
    expect(panelMaxHeight(view, 'sheet-raise')).toBe('100%');
    await fireEvent(view.getByTestId('sheet-search-probe'), 'blur');
    expect(panelMaxHeight(view, 'sheet-raise')).toBe('80%');
  });
});

describe('Sheet dismissible=false 诚实口径（批 D）', () => {
  it('无关闭钮、遮罩点按不关、系统返回不关（必须表态）', async () => {
    const onClose = jest.fn();
    const view = await renderWithProviders(
      <Sheet keyboard="none"
        visible
        onClose={onClose}
        title="需要决定"
        dismissible={false}
        testID="sheet-guard"
      >
        <AppText>决策内容</AppText>
      </Sheet>
    );
    expect(view.queryByTestId('sheet-close')).toBeNull();
    fireEvent.press(view.getByTestId('sheet-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
    pressSystemBack();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('缺省可关：关闭钮在场、遮罩点按关闭、系统返回关闭', async () => {
    const onClose = jest.fn();
    const view = await renderWithProviders(
      <Sheet keyboard="none" visible onClose={onClose} title="普通面板" testID="sheet-plain">
        <AppText>内容</AppText>
      </Sheet>
    );
    expect(view.getByTestId('sheet-close')).toBeTruthy();
    fireEvent.press(view.getByTestId('sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    pressSystemBack();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Sheet backAction 钻取返回（批 D）', () => {
  it('标题槽出返回钮：点按只退钻取；系统返回同样先退钻取、不关 Sheet', async () => {
    const onClose = jest.fn();
    const onBack = jest.fn();
    const view = await renderWithProviders(
      <Sheet keyboard="none"
        visible
        onClose={onClose}
        title="子页"
        backAction={{ onPress: onBack }}
        testID="sheet-drill"
      >
        <AppText>钻取内容</AppText>
      </Sheet>
    );
    fireEvent.press(view.getByTestId('sheet-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    pressSystemBack();
    expect(onBack).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Sheet 关闭末帧冻结（批 D）', () => {
  it('visible 落下同帧宿主换内容，出场期间仍呈现最后一帧', async () => {
    const view = await renderWithProviders(
      <Sheet keyboard="none"
        visible
        onClose={() => undefined}
        title="第一帧标题"
        testID="sheet-freeze"
      >
        <AppText>第一帧内容</AppText>
      </Sheet>
    );
    expect(view.getByText('第一帧内容')).toBeTruthy();
    await view.rerender(
      <Sheet keyboard="none"
        visible={false}
        onClose={() => undefined}
        title="关闭后标题"
        testID="sheet-freeze"
      >
        <AppText>关闭后内容</AppText>
      </Sheet>
    );
    expect(view.getByText('第一帧内容')).toBeTruthy();
    expect(view.queryByText('关闭后内容')).toBeNull();
    expect(view.getByText('第一帧标题')).toBeTruthy();
  });
});

describe('SheetOptionRow 纯净极简视觉重塑', () => {
  it('默认透明底色、48dp 最小触控热区与按压禁用状态正确', async () => {
    const onPlainPress = jest.fn();
    const onDisabledPress = jest.fn();
    const view = await renderWithProviders(
      <Sheet keyboard="none" visible onClose={() => undefined} title="选项测试">
        <SheetOptionRow
          testID="row-plain"
          label="纯净无界选项"
          onPress={onPlainPress}
        />
        <SheetOptionRow
          testID="row-disabled"
          label="离线设备"
          disabled
          onPress={onDisabledPress}
        />
        <SheetOptionRow
          testID="row-selected"
          label="选中设备"
          selected
          hint="在线"
          hintTone="success"
          onPress={jest.fn()}
        />
      </Sheet>
    );

    // 默认透明背景与 48dp 最小高度（彻底移除灰色卡片底 fillSubtle）
    const plainNode = view.getByTestId('row-plain');
    const plainStyle = StyleSheet.flatten(plainNode.props.style);
    expect(plainStyle.backgroundColor).toBe('transparent');
    expect(plainStyle.minHeight).toBe(48);
    expect(plainStyle.opacity).toBe(1);

    // 触发点按
    fireEvent.press(plainNode);
    expect(onPlainPress).toHaveBeenCalledTimes(1);

    // 禁用态弱化呈现（0.45 透明度）且不可点
    const disabledNode = view.getByTestId('row-disabled');
    const disabledStyle = StyleSheet.flatten(disabledNode.props.style);
    expect(disabledStyle.opacity).toBe(0.45);
    fireEvent.press(disabledNode);
    expect(onDisabledPress).not.toHaveBeenCalled();

    // 选中态对号与内联提示文案
    expect(view.getByTestId('row-selected')).toBeTruthy();
    expect(view.getByText('选中设备')).toBeTruthy();
    expect(view.getByText('在线')).toBeTruthy();
  });
});

describe('Sheet 退场物理卸载与 onCloseComplete', () => {
  it('退场未完成时重新打开会取消卸载，回调只在真正退完后出现一次', async () => {
    const onCloseComplete = jest.fn();
    const view = await renderWithProviders(
      <Sheet
        keyboard="none"
        visible
        onClose={() => undefined}
        onCloseComplete={onCloseComplete}
        testID="sheet-reopen"
      >
        <AppText>仍在</AppText>
      </Sheet>
    );
    jest.useFakeTimers();
    try {
      await view.rerender(
        <Sheet
          keyboard="none"
          visible={false}
          onClose={() => undefined}
          onCloseComplete={onCloseComplete}
          testID="sheet-reopen"
        >
          <AppText>仍在</AppText>
        </Sheet>
      );
      await act(async () => {
        jest.advanceTimersByTime(100);
      });
      expect(view.getByTestId('sheet-reopen')).toBeTruthy();
      await view.rerender(
        <Sheet
          keyboard="none"
          visible
          onClose={() => undefined}
          onCloseComplete={onCloseComplete}
          testID="sheet-reopen"
        >
          <AppText>仍在</AppText>
        </Sheet>
      );
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      expect(onCloseComplete).not.toHaveBeenCalled();
      expect(view.getByTestId('sheet-reopen')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('visible 从 true 变为 false 时，退场完成调用 onCloseComplete 且物理卸载', async () => {
    const onCloseComplete = jest.fn();
    const view = await renderWithProviders(
      <Sheet keyboard="none"
        visible
        onClose={() => undefined}
        onCloseComplete={onCloseComplete}
        testID="sheet-exit-test"
      >
        <AppText>面板内容</AppText>
      </Sheet>
    );

    expect(view.getByTestId('sheet-exit-test')).toBeTruthy();
    expect(onCloseComplete).not.toHaveBeenCalled();

    jest.useFakeTimers();
    try {
      // 宿主将 visible 置为 false
      await view.rerender(
        <Sheet keyboard="none"
          visible={false}
          onClose={() => undefined}
          onCloseComplete={onCloseComplete}
          testID="sheet-exit-test"
        >
          <AppText>面板内容</AppText>
        </Sheet>
      );

      // 动画未播完期间仍在树中（末帧冻结）
      expect(view.getByTestId('sheet-exit-test')).toBeTruthy();
      expect(onCloseComplete).not.toHaveBeenCalled();

      // 快进退场动画耗时（300ms 兜底）
      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      // 退场播完：onCloseComplete 被调用且内部 Modal 卸载
      expect(onCloseComplete).toHaveBeenCalledTimes(1);
      expect(view.queryByTestId('sheet-exit-test')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('handleDismiss 交互触发关闭，退场后调用 onCloseComplete', async () => {
    const onClose = jest.fn();
    const onCloseComplete = jest.fn();
    const view = await renderWithProviders(
      <Sheet keyboard="none"
        visible
        onClose={onClose}
        onCloseComplete={onCloseComplete}
        testID="sheet-dismiss-test"
      >
        <AppText>面板内容</AppText>
      </Sheet>
    );

    // 点击遮罩
    await fireEvent.press(view.getByTestId('sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);

    jest.useFakeTimers();
    try {
      // 宿主响应 onClose 将 visible 置为 false
      await view.rerender(
        <Sheet keyboard="none"
          visible={false}
          onClose={onClose}
          onCloseComplete={onCloseComplete}
          testID="sheet-dismiss-test"
        >
          <AppText>面板内容</AppText>
        </Sheet>
      );

      // 快进退场
      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      expect(onCloseComplete).toHaveBeenCalledTimes(1);
      expect(view.queryByTestId('sheet-dismiss-test')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('useOverlayHost 与 Sheet 联动生命周期闭环', () => {
  function TestHost() {
    const host = useOverlayHost<'sampleSheet'>();
    return (
      <View>
        <Pressable
          testID="btn-open"
          onPress={() => host.openOverlay('sampleSheet')}
        />
        <Pressable testID="btn-close" onPress={() => host.closeOverlay()} />
        {host.isMounted('sampleSheet') && (
          <Sheet keyboard="none"
            visible={host.isOpen('sampleSheet')}
            onClose={host.closeOverlay}
            onCloseComplete={() => host.onOverlayExited('sampleSheet')}
            testID="integrated-sheet"
          >
            <AppText>集成内容</AppText>
          </Sheet>
        )}
      </View>
    );
  }

  it('完整闭环：openOverlay 挂载呈现 -> closeOverlay 退场中仍挂载 -> 播完物理彻底卸载', async () => {
    const view = await renderWithProviders(<TestHost />);

    // 1. 初始：未挂载
    expect(view.queryByTestId('integrated-sheet')).toBeNull();

    // 2. 点击打开
    await act(async () => {
      fireEvent.press(view.getByTestId('btn-open'));
    });
    expect(view.getByTestId('integrated-sheet')).toBeTruthy();
    expect(view.getByText('集成内容')).toBeTruthy();

    // 3. 点击关闭：逻辑关闭，Sheet 收到 visible=false，但宿主 isMounted 仍为 true，内容仍挂载（末帧冻结）
    jest.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.press(view.getByTestId('btn-close'));
      });
      expect(view.getByTestId('integrated-sheet')).toBeTruthy();
      expect(view.getByText('集成内容')).toBeTruthy();

      // 4. 退场动画耗时流逝 -> Sheet 触发 onCloseComplete -> host.onOverlayExited -> isMounted 变为 false
      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      // 5. 宿主物理卸载完全清空，React 树中不再有 Sheet
      expect(view.queryByTestId('integrated-sheet')).toBeNull();
      expect(view.queryByText('集成内容')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
