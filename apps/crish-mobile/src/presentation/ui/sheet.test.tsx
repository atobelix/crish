// Sheet 键盘交接的回归网（批 A）：jest 键盘桩为收起态——呈现请求
// 到达时键盘不在场，交接门必须立即放行（内容同帧可达），不得把所有
// Sheet 平白扣一帧/扣一轮超时；visible=false 时内容不挂载。
// 批 D 追加：语义档位、dismissible=false 诚实口径、backAction 钻取
// 返回分发、搜索升档、关闭末帧冻结。
import { fireEvent, render } from '@testing-library/react-native';
import { TextInput } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import {
  AppText,
  nextSheetSize,
  SHEET_SIZE_RATIOS,
  Sheet,
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

describe('Sheet 键盘交接（收起态）', () => {
  it('visible 时内容可达（交接门立即放行）', async () => {
    const view = await renderWithProviders(
      <Sheet
        visible
        onClose={() => undefined}
        title="测试"
        testID="sheet-under-test"
      >
        <AppText>面板内容</AppText>
      </Sheet>
    );
    expect(view.getByTestId('sheet-under-test')).toBeTruthy();
    expect(view.getByText('面板内容')).toBeTruthy();
  });

  it('visible=false 时不挂载内容', async () => {
    const view = await renderWithProviders(
      <Sheet visible={false} onClose={() => undefined} testID="sheet-hidden">
        <AppText>不应出现</AppText>
      </Sheet>
    );
    expect(view.queryByTestId('sheet-hidden')).toBeNull();
    expect(view.queryByText('不应出现')).toBeNull();
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
      <Sheet
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
      <Sheet visible onClose={() => undefined} testID="sheet-default-size">
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
      <Sheet
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
      <Sheet
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
      <Sheet visible onClose={onClose} title="普通面板" testID="sheet-plain">
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
      <Sheet
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
      <Sheet
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
      <Sheet
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
