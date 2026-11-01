// 个人资料（原型 subProfileEdit）：头像 80（整头像 + 下方「点击更换头像」可点）
// + 相机徽章 28；昵称 / 个性签名为外置标签字段（系统选图、裁成方形，超过 3 MB 报错）。
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

/** 顶栏小号绿色胶囊「保存」 */
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

  const cameraSize = theme.size.cameraButton - 6;
  const avatarSize = theme.size.avatarEdit - theme.space.lg;

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
          paddingHorizontal: theme.space.lg,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <View
          style={[
            styles.avatarRow,
            {
              paddingTop: theme.space.sm,
              paddingBottom: theme.space.lg,
              gap: theme.space.sm,
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="更换头像"
            accessibilityState={{ disabled: uploading, busy: uploading }}
            disabled={uploading}
            testID="profile-camera"
            onPress={() => void changeAvatar()}
            style={styles.avatarPress}
          >
            <View>
              <AccountAvatar
                name={avatarName}
                uri={profile?.avatarUrl}
                size={avatarSize}
                testID="profile-avatar"
              />
              <View
                style={[
                  styles.camera,
                  theme.shadow.xs,
                  {
                    right: -theme.space.xxs,
                    bottom: -theme.space.xxs,
                    width: cameraSize,
                    height: cameraSize,
                    borderRadius: cameraSize / 2,
                    backgroundColor: theme.colors.field,
                    borderWidth: 2,
                    borderColor: theme.colors.surface,
                  },
                ]}
              >
                {uploading ? (
                  <ActivityIndicator color={theme.colors.textTertiary} />
                ) : (
                  <Icon
                    name="camera"
                    size={theme.size.iconSmall - 2}
                    color={theme.colors.textTertiary}
                  />
                )}
              </View>
            </View>
            <AppText
              variant="caption"
              color="textTertiary"
              style={{ marginTop: theme.space.sm }}
            >
              点击更换头像
            </AppText>
          </Pressable>
        </View>
        <AuthField
          label="用户昵称"
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="昵称"
          maxLength={NAME_MAX_LENGTH}
          autoCapitalize="none"
          error={nameEmpty ? '昵称不能为空' : null}
          testID="profile-name"
        />
        <AuthField
          label="个性签名"
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
  avatarPress: { alignItems: 'center' },
  camera: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveAction: { alignItems: 'center', justifyContent: 'center' },
});

export default AccountProfileScreen;
