// 账号 v3 账号页：头像 76 + 名字 + 邮箱；个人资料 / 登录设备 / 修改密码；退出登录与注销入口。
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import {
  listAccountSessions,
  logoutAccount,
} from '@/adapters/account/accountService';
import { AppText } from '@/presentation/ui';
import {
  AccountAvatar,
  AuthBar,
  AuthButton,
  AuthPage,
  NavRow,
  SignOutSheet,
} from './ui';

export interface AccountHomeScreenProps {
  onBack: () => void;
  onOpenProfile: () => void;
  onOpenSessions: () => void;
  onChangePassword: (email: string) => void;
  onOpenDelete: () => void;
  onSignedOut: () => void;
}

/** 展示名：资料昵称 → 账号名 → 邮箱前缀 */
export function displayNameOf(
  profileName: string | null | undefined,
  userName: string | null | undefined,
  email: string
): string {
  const candidate = profileName?.trim() || userName?.trim();
  return candidate || email.split('@')[0] || email;
}

export function AccountHomeScreen({
  onBack,
  onOpenProfile,
  onOpenSessions,
  onChangePassword,
  onOpenDelete,
  onSignedOut,
}: AccountHomeScreenProps) {
  const theme = useTheme();
  const user = useAccountStore((s) => s.user);
  const profile = useAccountStore((s) => s.profile);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let alive = true;
    listAccountSessions()
      .then((sessions) => {
        if (alive) setSessionCount(sessions.filter((s) => !s.revoked).length);
      })
      .catch(() => {
        // 数量只是辅助信息，失败时不显示
      });
    return () => {
      alive = false;
    };
  }, []);

  const email = profile?.email ?? user?.email ?? '';
  const name = displayNameOf(profile?.displayName, user?.name, email);

  const confirmSignOut = async () => {
    setSigningOut(true);
    await logoutAccount();
    setSigningOut(false);
    setSheetOpen(false);
    onSignedOut();
  };

  return (
    <AuthPage testID="account-home-screen">
      <AuthBar title="账号" onBack={onBack} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: theme.space.section }}
      >
        <View
          style={[
            styles.identity,
            { paddingVertical: theme.space.xxl, gap: theme.space.xs },
          ]}
        >
          <AccountAvatar
            name={name}
            uri={profile?.avatarUrl}
            size={theme.size.avatarProfile}
            testID="account-avatar"
          />
          <AppText
            variant="accountName"
            color="textPrimary"
            style={{ marginTop: theme.space.md }}
            testID="account-name"
          >
            {name}
          </AppText>
          <AppText variant="footnote" color="textSecondary">
            {email}
          </AppText>
        </View>
        <NavRow
          label="个人资料"
          testID="account-row-profile"
          onPress={onOpenProfile}
        />
        <NavRow
          label="登录设备"
          value={sessionCount === null ? undefined : String(sessionCount)}
          testID="account-row-sessions"
          onPress={onOpenSessions}
        />
        <NavRow
          label="修改密码"
          last
          testID="account-row-password"
          onPress={() => onChangePassword(email)}
        />
        <View
          style={{
            paddingHorizontal: theme.layout.accountPageX,
            paddingTop: theme.space.section,
            gap: theme.space.lg,
          }}
        >
          <AuthButton
            label="退出登录"
            variant="secondary"
            danger
            testID="account-sign-out"
            onPress={() => setSheetOpen(true)}
          />
          <Pressable
            accessibilityRole="button"
            testID="account-delete-entry"
            onPress={onOpenDelete}
            style={styles.center}
          >
            <AppText variant="footnote" color="textTertiary">
              注销账号
            </AppText>
          </Pressable>
        </View>
      </ScrollView>
      <SignOutSheet
        visible={sheetOpen}
        busy={signingOut}
        onCancel={() => setSheetOpen(false)}
        onConfirm={() => void confirmSignOut()}
      />
    </AuthPage>
  );
}

const styles = StyleSheet.create({
  identity: { alignItems: 'center' },
  center: { alignItems: 'center' },
});

export default AccountHomeScreen;
