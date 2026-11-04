// 链接统一出口断言（审计 §D.2)：白名单协议放行、其余协议不调用 openURL。
import * as Linking from 'expo-linking';
import { openLink } from './openLink';

jest.mock('expo-linking', () => ({
  openURL: jest.fn(async () => undefined),
}));

const openURLMock = Linking.openURL as jest.MockedFunction<
  typeof Linking.openURL
>;

beforeEach(() => {
  openURLMock.mockClear();
});

describe('openLink', () => {
  it('http / https / mailto 放行并调用 openURL', async () => {
    await expect(openLink('https://example.com/docs')).resolves.toBe(true);
    await expect(openLink('http://example.com')).resolves.toBe(true);
    await expect(openLink('mailto:team@example.com')).resolves.toBe(true);
    expect(openURLMock).toHaveBeenCalledTimes(3);
    expect(openURLMock).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('javascript: / file: / 自定义 scheme 一律不调用', async () => {
    await expect(openLink('javascript:alert(1)')).resolves.toBe(false);
    await expect(openLink('file:///etc/passwd')).resolves.toBe(false);
    await expect(openLink('crish://open/session')).resolves.toBe(false);
    await expect(openLink('ftp://example.com/file')).resolves.toBe(false);
    expect(openURLMock).not.toHaveBeenCalled();
  });

  it('非法 URL 不调用、不抛错', async () => {
    await expect(openLink('not a url')).resolves.toBe(false);
    expect(openURLMock).not.toHaveBeenCalled();
  });
});
