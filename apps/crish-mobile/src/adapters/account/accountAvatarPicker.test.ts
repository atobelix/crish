// 头像选取：权限拒绝 / 取消 / 超过 3 MB / 正常转 data URL。
import * as ImagePicker from 'expo-image-picker';
import { AVATAR_MAX_BYTES, pickSquareAvatar } from './accountAvatarPicker';

jest.mock('expo-image-picker', () => ({
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied' },
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

const requestPermission = jest.mocked(
  ImagePicker.requestMediaLibraryPermissionsAsync
);
const launch = jest.mocked(ImagePicker.launchImageLibraryAsync);

function grant(granted: boolean) {
  requestPermission.mockResolvedValue({
    granted,
    status: granted
      ? ImagePicker.PermissionStatus.GRANTED
      : ImagePicker.PermissionStatus.DENIED,
    canAskAgain: true,
    expires: 'never',
  });
}

function asset(
  overrides: Partial<ImagePicker.ImagePickerAsset>
): ImagePicker.ImagePickerAsset {
  return { uri: 'file://a.jpg', width: 10, height: 10, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('pickSquareAvatar', () => {
  it('无相册权限 → denied，不打开选图', async () => {
    grant(false);
    await expect(pickSquareAvatar()).resolves.toEqual({ kind: 'denied' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('按方形裁剪打开选图；取消 → cancelled', async () => {
    grant(true);
    launch.mockResolvedValue({ canceled: true, assets: null });
    await expect(pickSquareAvatar()).resolves.toEqual({ kind: 'cancelled' });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ allowsEditing: true, aspect: [1, 1] })
    );
  });

  it('超过 3 MB → tooLarge', async () => {
    grant(true);
    launch.mockResolvedValue({
      canceled: false,
      assets: [asset({ base64: 'AAAA', fileSize: AVATAR_MAX_BYTES + 1 })],
    });
    await expect(pickSquareAvatar()).resolves.toEqual({ kind: 'tooLarge' });
  });

  it('正常 → data URL 与文件名', async () => {
    grant(true);
    launch.mockResolvedValue({
      canceled: false,
      assets: [
        asset({
          base64: 'AAAA',
          fileSize: 3,
          mimeType: 'image/png',
          fileName: 'me.png',
        }),
      ],
    });
    await expect(pickSquareAvatar()).resolves.toEqual({
      kind: 'picked',
      dataUrl: 'data:image/png;base64,AAAA',
      fileName: 'me.png',
    });
  });
});
