// 账号头像：有图显示图片，无图显示名字首字；配色取头像色板（原型统一中性灰，各档同值）。
import { Image, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { resolveAvatarUrl } from '@/adapters/account/accountApi';
import { AppText } from '@/presentation/ui';

/** 头像色档下标（M1 起各档同为中性灰，下标仅作稳定取档） */
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
