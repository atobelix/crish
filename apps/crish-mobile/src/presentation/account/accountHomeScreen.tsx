// 账号页（原型 subAccount）：透明 hero（头像 68 + 名字 16/600）+ 白色分组卡行
// （个人资料 / 用户 UID（点击复制，资料就绪才显示）/ 登录设备 / 修改密码）；
// 退出登录与注销入口。邮箱行保留为 App 侧账号标识展示（原型 hero 无邮箱行，
// 邮箱见设置账号卡/登录流程）。
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import {
  listAccountSessions,
  logoutAccount,
} from '@/adapters/account/accountService';
import { copyTextToClipboard } from '@/adapters/platform/clipboard';
import { AppText, useToast } from '@/presentation/ui';
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
  const { showToast } = useToast();
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
  /** 账号 UID（资料真源 AccountProfile.accountId；无资料时不渲染该行） */
  const uid = profile?.accountId ?? '';

  const copyUid = async () => {
    const ok = await copyTextToClipboard(uid);
    showToast(
      ok ? '已复制 UID' : '复制失败，请稍后重试',
      ok ? 'success' : 'error'
    );
  };

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
            {
              paddingTop: theme.space.lg + 2,
              paddingBottom: theme.space.sm + 2,
              gap: theme.space.md,
            },
          ]}
        >
          <AccountAvatar
            name={name}
            uri={profile?.avatarUrl}
            size={theme.size.avatarProfile - theme.space.sm}
            testID="account-avatar"
          />
          <AppText
            variant="accountName"
            color="textPrimary"
            testID="account-name"
          >
            {name}
          </AppText>
          <AppText
            variant="footnote"
            color="textTertiary"
            style={{ marginTop: -theme.space.sm }}
          >
            {email}
          </AppText>
        </View>
        <View
          style={{
            marginHorizontal: theme.space.lg,
            borderRadius: theme.radius.card,
            backgroundColor: theme.colors.surfaceGrouped,
            overflow: 'hidden',
          }}
        >
          <NavRow
            label="个人资料"
            testID="account-row-profile"
            onPress={onOpenProfile}
          />
          {uid ? (
            <NavRow
              label="用户 UID"
              value={uid}
              trailingIcon="copy"
              testID="account-row-uid"
              onPress={() => void copyUid()}
            />
          ) : null}
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
        </View>
        <View
          style={{
            paddingHorizontal: theme.space.lg,
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
