/* eslint-disable @typescript-eslint/no-require-imports */
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { RequireGuest } from './RequireGuest';
import { authStore } from '@/domain/store/authStore';
import { accountStore } from '@/domain/store/accountStore';

jest.mock('expo-router', () => {
  const ReactMock = require('react');
  const { Text: TextMock } = require('react-native');
  return {
    Redirect: jest.fn(({ href }: { href: string }) => {
      return ReactMock.createElement(
        TextMock,
        { testID: 'redirect-target' },
        href
      );
    }),
  };
});

describe('RequireGuest', () => {
  beforeEach(() => {
    authStore.setState({ pairState: 'unpaired' });
    accountStore.setState({ status: 'loggedOut', user: null });
  });

  it('未认证（未配对且未登录）时，正常渲染子组件', async () => {
    await render(
      <RequireGuest>
        <Text testID="guest-child">欢迎登录</Text>
      </RequireGuest>
    );

    expect(screen.getByTestId('guest-child')).toBeTruthy();
    expect(screen.queryByTestId('redirect-target')).toBeNull();
  });

  it('已通过账号登录（status = loggedIn）时，重定向到 "/" 且不渲染子组件', async () => {
    accountStore.setState({ status: 'loggedIn' });

    await render(
      <RequireGuest>
        <Text testID="guest-child">欢迎登录</Text>
      </RequireGuest>
    );

    expect(screen.queryByTestId('guest-child')).toBeNull();
    const redirectEl = screen.getByTestId('redirect-target');
    expect(redirectEl.props.children).toBe('/');
  });

  it('已通过局域网配对（pairState = paired）时，重定向到 "/" 且不渲染子组件', async () => {
    authStore.setState({ pairState: 'paired' });

    await render(
      <RequireGuest>
        <Text testID="guest-child">欢迎登录</Text>
      </RequireGuest>
    );

    expect(screen.queryByTestId('guest-child')).toBeNull();
    const redirectEl = screen.getByTestId('redirect-target');
    expect(redirectEl.props.children).toBe('/');
  });
});
