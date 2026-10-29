// 账号 v3 个人资料：头像 96 + 相机钮（系统选图、裁成方形，超过 3 MB 报错）、昵称、简介。
// 有改动时顶栏右侧才出现「保存」；昵称为空时「保存」置灰并在昵称下提示。
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import {
  refreshAccountProfile,
  saveAccountProfile,
  uploadAccountAvatarImage,
} from '@/adapters/account/accountService';
import {
  pickSquareAvatar,
  type AvatarPickResult,
} from '@/adapters/account/accountAvatarPicker';
import { AppText, Icon } from '@/presentation/ui';
import { AccountAvatar, AuthBar, AuthField, AuthPage } from './ui';
import { displayNameOf } from './accountHomeScreen';

const NAME_MAX_LENGTH = 40;
const BIO_MAX_LENGTH = 200;

export interface ProfileDraft {
  displayName: string;
  bio: string;
}

/** 与已保存资料相比是否有改动（昵称按去首尾空格比较） */
export function isProfileDirty(
  draft: ProfileDraft,
  saved: ProfileDraft
): boolean {
  return (
    draft.displayName.trim() !== saved.displayName || draft.bio !== saved.bio
  );
}

/** 选图结果 → 错误文案；取消与成功不出错 */
export function avatarPickErrorOf(result: AvatarPickResult): string | null {
  if (result.kind === 'denied') return '需要相册权限才能更换头像';
  if (result.kind === 'tooLarge') return '图片不能超过 3 MB';
  return null;
}

function errorMessageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface SaveActionProps {
  disabled: boolean;
  loading: boolean;
  onPress: () => void;
}

/** 顶栏小号墨色胶囊「保存」 */
function SaveAction({ disabled, loading, onPress }: SaveActionProps) {
  const theme = useTheme();
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="保存"
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      testID="profile-save"
      onPress={onPress}
      style={({ pressed }) => [
        styles.saveAction,
        {
          height: theme.size.barAction,
          paddingHorizontal: theme.space.md,
          borderRadius: theme.radius.pill,
          backgroundColor: disabled
            ? theme.colors.fillSubtle
            : pressed
              ? theme.colors.actionPrimaryPressed
              : theme.colors.actionPrimary,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.colors.actionPrimaryText} />
      ) : (
        <AppText
          variant="barAction"
          color={disabled ? 'textDisabled' : 'actionPrimaryText'}
        >
          保存
        </AppText>
      )}
    </Pressable>
  );
}

export interface AccountProfileScreenProps {
  onBack: () => void;
}

export function AccountProfileScreen({ onBack }: AccountProfileScreenProps) {
  const theme = useTheme();
  const user = useAccountStore((s) => s.user);
  const profile = useAccountStore((s) => s.profile);
  const saved: ProfileDraft = {
    displayName: profile?.displayName ?? user?.name ?? '',
    bio: profile?.bio ?? '',
  };
  const [displayName, setDisplayName] = useState(saved.displayName);
  const [bio, setBio] = useState(saved.bio);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshAccountProfile();
  }, []);

  // 只在已保存的昵称 / 简介变化时同步草稿：头像上传刷新资料不会冲掉未保存的输入
  useEffect(() => {
    setDisplayName(saved.displayName);
    setBio(saved.bio);
  }, [saved.displayName, saved.bio]);

  const draft = { displayName, bio };
  const dirty = isProfileDirty(draft, saved);
  const nameEmpty = displayName.trim() === '';
  const email = profile?.email ?? user?.email ?? '';
  const avatarName = displayNameOf(saved.displayName, user?.name, email);

  const save = async () => {
    if (!dirty || nameEmpty || saving) return;
    setError(null);
    setSaving(true);
    try {
      await saveAccountProfile({ displayName: displayName.trim(), bio });
    } catch (err) {
      setError(errorMessageOf(err, '保存失败，请重试'));
    } finally {
      setSaving(false);
    }
  };

  const changeAvatar = async () => {
    if (uploading) return;
    setError(null);
    const result = await pickSquareAvatar();
    const pickError = avatarPickErrorOf(result);
    if (pickError) {
      setError(pickError);
      return;
    }
    if (result.kind !== 'picked') return;
    setUploading(true);
    try {
      await uploadAccountAvatarImage(result.dataUrl, result.fileName);
    } catch (err) {
      setError(errorMessageOf(err, '头像上传失败，请重试'));
    } finally {
      setUploading(false);
    }
  };

  const cameraSize = theme.size.cameraButton;

  return (
    <AuthPage testID="account-profile-screen">
      <AuthBar
        title="个人资料"
        onBack={onBack}
        right={
          dirty ? (
            <SaveAction
              disabled={nameEmpty}
              loading={saving}
              onPress={() => void save()}
            />
          ) : null
        }
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: theme.layout.accountPageX,
          paddingBottom: theme.space.section,
          gap: theme.space.sm,
        }}
      >
        <View
          style={[
            styles.avatarRow,
            { paddingTop: theme.space.xl, paddingBottom: theme.space.xxl },
          ]}
        >
          <View>
            <AccountAvatar
              name={avatarName}
              uri={profile?.avatarUrl}
              size={theme.size.avatarEdit}
              testID="profile-avatar"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="更换头像"
              accessibilityState={{ disabled: uploading, busy: uploading }}
              disabled={uploading}
              testID="profile-camera"
              onPress={() => void changeAvatar()}
              style={[
                styles.camera,
                {
                  right: -theme.space.xs,
                  bottom: -theme.space.xs,
                  width: cameraSize,
                  height: cameraSize,
                  borderRadius: cameraSize / 2,
                  borderWidth: theme.layout.avatarRing,
                  borderColor: theme.colors.canvas,
                  backgroundColor: theme.colors.field,
                },
              ]}
            >
              {uploading ? (
                <ActivityIndicator color={theme.colors.textPrimary} />
              ) : (
                <Icon
                  name="camera"
                  size={theme.size.iconSmall}
                  color={theme.colors.textPrimary}
                />
              )}
            </Pressable>
          </View>
        </View>
        <AuthField
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="昵称"
          maxLength={NAME_MAX_LENGTH}
          autoCapitalize="none"
          error={nameEmpty ? '昵称不能为空' : null}
          testID="profile-name"
        />
        <AuthField
          value={bio}
          onChangeText={setBio}
          placeholder="简介"
          maxLength={BIO_MAX_LENGTH}
          tall
          testID="profile-bio"
        />
        {error ? (
          <AppText variant="footnote" color="danger" testID="profile-error">
            {error}
          </AppText>
        ) : null}
      </ScrollView>
    </AuthPage>
  );
}

const styles = StyleSheet.create({
  avatarRow: { alignItems: 'center' },
  camera: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveAction: { alignItems: 'center', justifyContent: 'center' },
});

export default AccountProfileScreen;
