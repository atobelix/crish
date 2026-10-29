// 账号 v3 个人资料：有改动才出现「保存」、昵称为空不能保存、相机钮选图（超 3 MB 报错）后上传。
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import {
  refreshAccountProfile,
  saveAccountProfile,
  uploadAccountAvatarImage,
} from '@/adapters/account/accountService';
import { pickSquareAvatar } from '@/adapters/account/accountAvatarPicker';
import { accountStore } from '@/domain/store/accountStore';
import type { AccountProfile } from '@/domain/types/account';
import {
  AccountProfileScreen,
  avatarPickErrorOf,
  isProfileDirty,
} from './accountProfileScreen';

jest.mock('@/adapters/account/accountService', () => ({
  refreshAccountProfile: jest.fn(async () => undefined),
  saveAccountProfile: jest.fn(),
  uploadAccountAvatarImage: jest.fn(),
}));

jest.mock('@/adapters/account/accountAvatarPicker', () => ({
  pickSquareAvatar: jest.fn(),
}));

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

const PROFILE: AccountProfile = {
  accountId: 'u',
  email: 'a@b.co',
  displayName: '小明',
  avatarUrl: null,
  avatarFileId: null,
  bio: '你好',
  profileUpdatedAt: 1,
};

function renderProfile() {
  return render(<AccountProfileScreen onBack={jest.fn()} />, {
    wrapper: Providers,
  });
}

function isDisabled(node: { props: Record<string, unknown> }): boolean {
  const state = node.props.accessibilityState as
    { disabled?: boolean } | undefined;
  return state?.disabled === true;
}

beforeEach(() => {
  jest.clearAllMocks();
  accountStore.getState().reset();
  accountStore.getState().setUser({ id: 'u', email: 'a@b.co', name: '小明' });
  accountStore.getState().setProfile(PROFILE);
});

describe('纯函数', () => {
  it('isProfileDirty：昵称按去空格比较，简介按原文比较', () => {
    const saved = { displayName: '小明', bio: '你好' };
    expect(isProfileDirty({ displayName: ' 小明 ', bio: '你好' }, saved)).toBe(
      false
    );
    expect(isProfileDirty({ displayName: '小红', bio: '你好' }, saved)).toBe(
      true
    );
    expect(isProfileDirty({ displayName: '小明', bio: '' }, saved)).toBe(true);
  });

  it('avatarPickErrorOf', () => {
    expect(avatarPickErrorOf({ kind: 'tooLarge' })).toBe('图片不能超过 3 MB');
    expect(avatarPickErrorOf({ kind: 'denied' })).toBe(
      '需要相册权限才能更换头像'
    );
    expect(avatarPickErrorOf({ kind: 'cancelled' })).toBeNull();
  });
});

describe('AccountProfileScreen', () => {
  it('打开即刷新资料；无改动时不显示「保存」', async () => {
    const view = await renderProfile();
    expect(refreshAccountProfile).toHaveBeenCalled();
    expect(view.getByTestId('profile-name').props.value).toBe('小明');
    expect(view.queryByTestId('profile-save')).toBeNull();
  });

  it('改动后出现「保存」，提交去空格昵称与简介', async () => {
    jest.mocked(saveAccountProfile).mockResolvedValue({
      ...PROFILE,
      displayName: '小红',
    });
    const view = await renderProfile();
    await fireEvent.changeText(view.getByTestId('profile-name'), ' 小红 ');
    await fireEvent.press(view.getByTestId('profile-save'));
    await waitFor(() =>
      expect(saveAccountProfile).toHaveBeenCalledWith({
        displayName: '小红',
        bio: '你好',
      })
    );
  });

  it('昵称为空：保存置灰并提示', async () => {
    const view = await renderProfile();
    await fireEvent.changeText(view.getByTestId('profile-name'), '  ');
    expect(isDisabled(view.getByTestId('profile-save'))).toBe(true);
    expect(view.getByTestId('profile-name-error')).toHaveTextContent(
      '昵称不能为空'
    );
    await fireEvent.press(view.getByTestId('profile-save'));
    expect(saveAccountProfile).not.toHaveBeenCalled();
  });

  it('选图超过 3 MB 时报错且不上传', async () => {
    jest.mocked(pickSquareAvatar).mockResolvedValue({ kind: 'tooLarge' });
    const view = await renderProfile();
    await fireEvent.press(view.getByTestId('profile-camera'));
    await waitFor(() =>
      expect(view.getByTestId('profile-error')).toHaveTextContent(
        '图片不能超过 3 MB'
      )
    );
    expect(uploadAccountAvatarImage).not.toHaveBeenCalled();
  });

  it('选图成功后上传头像', async () => {
    jest.mocked(pickSquareAvatar).mockResolvedValue({
      kind: 'picked',
      dataUrl: 'data:image/jpeg;base64,AAAA',
      fileName: 'a.jpg',
    });
    jest.mocked(uploadAccountAvatarImage).mockResolvedValue(PROFILE);
    const view = await renderProfile();
    await fireEvent.press(view.getByTestId('profile-camera'));
    await waitFor(() =>
      expect(uploadAccountAvatarImage).toHaveBeenCalledWith(
        'data:image/jpeg;base64,AAAA',
        'a.jpg'
      )
    );
    expect(view.queryByTestId('profile-error')).toBeNull();
  });
});
