// 路由安全返回测试：深链 / 推送冷启动时导航栈只有当前页，裸 router.back()
// 会静默失效（用户被困在页面里只能强杀应用）。useSafeBack 必须在这种情况下
// 回落到首页。
//
// 用「探针组件 + render」而非 renderHook：本仓库 @testing-library/react-native
// 版本的 render 为异步返回，探针能直接拿到实际传给子组件的回调。
import { router } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import {
  useSafeBack,
  SAFE_BACK_FALLBACK_HREF,
} from '@/presentation/navigation/useSafeBack';

jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: jest.fn(),
  },
}));

const backMock = router.back as jest.Mock;
const replaceMock = router.replace as jest.Mock;
const canGoBackMock = router.canGoBack as jest.Mock;

/** 把 hook 返回值挂到按钮上，便于从测试里触发 */
function Probe(): React.ReactElement {
  const goBack = useSafeBack();
  return (
    <Pressable testID="probe-back" onPress={goBack}>
      <Text>back</Text>
    </Pressable>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useSafeBack', () => {
  it('栈深度足够时正常回退（保留用户来路）', async () => {
    canGoBackMock.mockReturnValue(true);
    await render(<Probe />);

    fireEvent.press(screen.getByTestId('probe-back'));

    expect(backMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('栈深度为 1（深链/推送冷启动）时回落到首页，不调用 back', async () => {
    canGoBackMock.mockReturnValue(false);
    await render(<Probe />);

    fireEvent.press(screen.getByTestId('probe-back'));

    expect(backMock).not.toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledWith(SAFE_BACK_FALLBACK_HREF);
  });

  it('兜底落点为首页 tab 根', () => {
    expect(SAFE_BACK_FALLBACK_HREF).toBe('/');
  });

  it('多次触发行为一致（幂等，无隐藏状态）', async () => {
    canGoBackMock.mockReturnValue(false);
    await render(<Probe />);

    fireEvent.press(screen.getByTestId('probe-back'));
    fireEvent.press(screen.getByTestId('probe-back'));

    expect(replaceMock).toHaveBeenCalledTimes(2);
    expect(replaceMock).toHaveBeenNthCalledWith(1, SAFE_BACK_FALLBACK_HREF);
  });
});
