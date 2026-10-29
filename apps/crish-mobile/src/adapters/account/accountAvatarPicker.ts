// 头像选取：系统相册选图 → 方形裁剪 → 转 data URL；超过账号中心 3 MB 上限时直接拒绝。
// 只负责选图与校验，不上传；上传走 accountService.uploadAccountAvatarImage。
import * as ImagePicker from 'expo-image-picker';

/** 账号中心头像上限 3 MB */
export const AVATAR_MAX_BYTES = 3 * 1024 * 1024;

const DEFAULT_MIME = 'image/jpeg';
const PICK_QUALITY = 0.8;
/** base64 → 原始字节的换算系数 */
const BASE64_BYTE_RATIO = 0.75;

export type AvatarPickResult =
  | { kind: 'picked'; dataUrl: string; fileName?: string }
  | { kind: 'cancelled' }
  | { kind: 'denied' }
  | { kind: 'tooLarge' };

export async function pickSquareAvatar(): Promise<AvatarPickResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { kind: 'denied' };
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: PICK_QUALITY,
    base64: true,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  const base64 = asset?.base64;
  if (!asset || !base64) return { kind: 'cancelled' };
  const bytes = asset.fileSize ?? base64.length * BASE64_BYTE_RATIO;
  if (bytes > AVATAR_MAX_BYTES) return { kind: 'tooLarge' };
  const mime = asset.mimeType ?? DEFAULT_MIME;
  return {
    kind: 'picked',
    dataUrl: `data:${mime};base64,${base64}`,
    fileName: asset.fileName ?? undefined,
  };
}
