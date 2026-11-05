// useOverlayHost 单元测试：
// 覆盖打开、关闭、退场卸载、排他性、迟到退场防串扰及与 Sheet 配合的完整生命周期。
import { act, renderHook } from '@testing-library/react-native';
import { useOverlayHost } from './useOverlayHost';

type TestOverlayKind = 'sheetA' | 'sheetB' | 'sheetC';

describe('useOverlayHost 统一覆盖层状态机', () => {
  it('默认状态为未打开且未挂载', async () => {
    const { result } = await renderHook(() =>
      useOverlayHost<TestOverlayKind>()
    );

    expect(result.current.activeOverlay).toBeNull();
    expect(result.current.renderedOverlay).toBeNull();
    expect(result.current.isOpen('sheetA')).toBe(false);
    expect(result.current.isMounted('sheetA')).toBe(false);
  });

  it('支持传入初始覆盖层状态', async () => {
    const { result } = await renderHook(() =>
      useOverlayHost<TestOverlayKind>('sheetA')
    );

    expect(result.current.activeOverlay).toBe('sheetA');
    expect(result.current.renderedOverlay).toBe('sheetA');
    expect(result.current.isOpen('sheetA')).toBe(true);
    expect(result.current.isMounted('sheetA')).toBe(true);
    expect(result.current.isOpen('sheetB')).toBe(false);
    expect(result.current.isMounted('sheetB')).toBe(false);
  });

  it('打开流程：openOverlay 同时置位 active 与 rendered 状态', async () => {
    const { result } = await renderHook(() =>
      useOverlayHost<TestOverlayKind>()
    );

    await act(async () => {
      result.current.openOverlay('sheetA');
    });

    expect(result.current.activeOverlay).toBe('sheetA');
    expect(result.current.renderedOverlay).toBe('sheetA');
    expect(result.current.isOpen('sheetA')).toBe(true);
    expect(result.current.isMounted('sheetA')).toBe(true);
    expect(result.current.isOpen('sheetB')).toBe(false);
    expect(result.current.isMounted('sheetB')).toBe(false);
  });

  it('关闭流程（无参）：closeOverlay 置空 activeOverlay，但保留 renderedOverlay 等待退场', async () => {
    const { result } = await renderHook(() =>
      useOverlayHost<TestOverlayKind>()
    );

    await act(async () => {
      result.current.openOverlay('sheetA');
    });

    await act(async () => {
      result.current.closeOverlay();
    });

    // 逻辑关闭，驱动 visible=false 触发退场动画
    expect(result.current.activeOverlay).toBeNull();
    expect(result.current.isOpen('sheetA')).toBe(false);

    // 物理仍挂载，确保退场动画期间在树中
    expect(result.current.renderedOverlay).toBe('sheetA');
    expect(result.current.isMounted('sheetA')).toBe(true);
  });

  it('关闭流程（带目标保护）：仅当目标匹配时关闭，不误关其他层', async () => {
    const { result } = await renderHook(() =>
      useOverlayHost<TestOverlayKind>()
    );

    await act(async () => {
      result.current.openOverlay('sheetA');
    });

    // 尝试关闭 sheetB，不影响 sheetA
    await act(async () => {
      result.current.closeOverlay('sheetB');
    });
    expect(result.current.activeOverlay).toBe('sheetA');
    expect(result.current.isOpen('sheetA')).toBe(true);

    // 关闭目标匹配的 sheetA
    await act(async () => {
      result.current.closeOverlay('sheetA');
    });
    expect(result.current.activeOverlay).toBeNull();
    expect(result.current.isOpen('sheetA')).toBe(false);
    expect(result.current.renderedOverlay).toBe('sheetA');
  });

  it('退场卸载闭环：onOverlayExited 清空 renderedOverlay 实现物理卸载', async () => {
    const { result } = await renderHook(() =>
      useOverlayHost<TestOverlayKind>()
    );

    await act(async () => {
      result.current.openOverlay('sheetA');
    });
    await act(async () => {
      result.current.closeOverlay();
    });

    // 动画播完，触发退场回调
    await act(async () => {
      result.current.onOverlayExited('sheetA');
    });

    expect(result.current.activeOverlay).toBeNull();
    expect(result.current.renderedOverlay).toBeNull();
    expect(result.current.isOpen('sheetA')).toBe(false);
    expect(result.current.isMounted('sheetA')).toBe(false);
  });

  it('排他性：打开新覆盖层时直接替换当前层', async () => {
    const { result } = await renderHook(() =>
      useOverlayHost<TestOverlayKind>()
    );

    await act(async () => {
      result.current.openOverlay('sheetA');
    });
    expect(result.current.isOpen('sheetA')).toBe(true);

    // 打开 sheetB
    await act(async () => {
      result.current.openOverlay('sheetB');
    });

    expect(result.current.activeOverlay).toBe('sheetB');
    expect(result.current.renderedOverlay).toBe('sheetB');
    expect(result.current.isOpen('sheetA')).toBe(false);
    expect(result.current.isMounted('sheetA')).toBe(false);
    expect(result.current.isOpen('sheetB')).toBe(true);
    expect(result.current.isMounted('sheetB')).toBe(true);
  });

  it('防串扰：前一层迟到的 onOverlayExited 回调不会误卸载已打开的新层', async () => {
    const { result } = await renderHook(() =>
      useOverlayHost<TestOverlayKind>()
    );

    // 1. 打开 sheetA 并开始关闭
    await act(async () => {
      result.current.openOverlay('sheetA');
    });
    await act(async () => {
      result.current.closeOverlay();
    });
    expect(result.current.renderedOverlay).toBe('sheetA');

    // 2. 在 sheetA 退场完成前，用户打开了 sheetB
    await act(async () => {
      result.current.openOverlay('sheetB');
    });
    expect(result.current.activeOverlay).toBe('sheetB');
    expect(result.current.renderedOverlay).toBe('sheetB');

    // 3. 此时迟到的 sheetA 退场完成回调触发
    await act(async () => {
      result.current.onOverlayExited('sheetA');
    });

    // 验证：sheetB 依然稳固挂载与打开，未被 sheetA 的回调清空
    expect(result.current.activeOverlay).toBe('sheetB');
    expect(result.current.renderedOverlay).toBe('sheetB');
    expect(result.current.isOpen('sheetB')).toBe(true);
    expect(result.current.isMounted('sheetB')).toBe(true);
  });
});
