// 账号头像：有图显示图片，无图显示名字首字；配色取头像色板中的蓝色一档（与 v3 稿一致）。
import { Image, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { resolveAvatarUrl } from '@/adapters/account/accountApi';
import { AppText } from '@/presentation/ui';

/** v3 稿指定的头像色即 avatarTones 第 2 档（浅 #eef2fa/#3b5b92，深 #1d2433/#8faee0） */
const ACCOUNT_TONE_INDEX = 1;

export interface AccountAvatarProps {
  name: string;
  uri?: string | null;
  size: number;
  testID?: string;
}

export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

export function AccountAvatar({ name, uri, size, testID }: AccountAvatarProps) {
  const theme = useTheme();
  const tone = theme.avatarTones[ACCOUNT_TONE_INDEX] ?? theme.avatarTones[0];
  const frame = { width: size, height: size, borderRadius: size / 2 };
  // 后端头像地址可能是相对路径，统一补全账号中心域名
  const src = resolveAvatarUrl(uri);
  if (src) {
    return (
      <Image
        testID={testID}
        accessibilityLabel={`${name}的头像`}
        source={{ uri: src }}
        style={frame}
      />
    );
  }
  return (
    <View
      testID={testID}
      accessibilityLabel={`${name}的头像`}
      style={[styles.center, frame, { backgroundColor: tone?.bg }]}
    >
      <AppText
        variant="bodyStrong"
        style={{
          color: tone?.fg,
          fontSize: size * 0.4,
          lineHeight: size * 0.5,
        }}
      >
        {initialOf(name)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});

export default AccountAvatar;
