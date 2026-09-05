import { render } from '@testing-library/react-native';
import PairScanRoute from '../../../../app/pair/scan';

const mockRedirect = jest.fn();

jest.mock('expo-router', () => ({
  Redirect: (props: unknown) => {
    mockRedirect(props);
    return null;
  },
}));

beforeEach(() => {
  mockRedirect.mockClear();
});

describe('扫码配对路由（BLK-11 保护重定向）', () => {
  it('重定向至手动配对页 (/pair/manual)', async () => {
    await render(<PairScanRoute />);
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ href: '/pair/manual' })
    );
  });
});
