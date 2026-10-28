// 配对引导首页（F6 首次启动引导 / M5 §2.1 pair/welcome.tsx · R4 批次4 诚实化收口）：
// - 云端账号支持：登录同一账号 → 自动发现在线电脑（数据面就绪）；
// - 一键直连（诚实化）：中继票据申请失败如实展示错误（服务端未上线时 404 文案透传）；
//   **不再伪造配对态**——R4 前的实现把桌面 id 当本机 deviceId 写入 authStore.onPaired
//   且不落任何凭据（重启即失配 + 连接必然失败），已根除：配对态唯一入口 =
//   PairingWiring 配对握手（扫码/手动），云端直连待桌面中继链路上线后经完整握手接入；
// - 本地优先兜底：手动输入与扫码配对入口完整保留；
// - 已配对态兜底：authStore hydrated 且 paired → 展示已配对设备信息 + 进入应用。
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useTheme } from '@/adapters/platform/theme';
import {
  cloudAuthStore,
  useCloudAuthStore,
} from '@/adapters/cloud/cloudAuthStore';
import Button from '@/presentation/components/ui/Button';
import Input from '@/presentation/components/ui/Input';
import HeaderBackButton from '@/presentation/components/ui/HeaderBackButton';
import { dualHitSlop } from '@/presentation/components/ui/hitTargets';

export interface PairWelcomeScreenProps {
  /** 手动输入入口（→ /pair/manual） */
  onOpenManual: () => void;
  /** 扫码配对入口（→ /pair/scan 占位页，P2） */
  onOpenScan: () => void;
  /** 已配对态「进入应用」（→ (tabs)） */
  onEnterApp: () => void;
  /** 返回上一页（可选） */
  onBack?: () => void;
}

export default function PairWelcomeScreen({
  onOpenManual,
  onOpenScan,
  onEnterApp,
  onBack,
}: PairWelcomeScreenProps) {
  const theme = useTheme();
  const hydrated = useAuthStore((s) => s.hydrated);
  const pairState = useAuthStore((s) => s.pairState);
  const host = useAuthStore((s) => s.host);
  const desktopId = useAuthStore((s) => s.desktopId);
  const deviceId = useAuthStore((s) => s.deviceId);
  const paired = hydrated && pairState === 'paired';

  const isLoggedIn = useCloudAuthStore((s) => s.isLoggedIn);
  const cloudError = useCloudAuthStore((s) => s.error);
  const cloudLoading = useCloudAuthStore((s) => s.loading);
  const onlineDesktop = useCloudAuthStore((s) => s.onlineDesktop);
  const userEmail = useCloudAuthStore((s) => s.user?.email ?? null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showLogin, setShowLogin] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);

  const handleCloudLogin = async () => {
    if (!email || !password) return;
    try {
      await cloudAuthStore.getState().login(email, password);
      setPassword('');
      setShowLogin(false);
      // 登录成功即拉设备列表（fire-and-forget；失败留痕 store.error）
      void cloudAuthStore.getState().fetchDevices();
    } catch {
      // 错误已存入 cloudAuthStore.error（登录失败原因如实展示）
    }
  };

  // 一键直连（诚实化，R4 批次4）：申请中继票据 → 失败/成功均如实反馈；
  // 不写任何配对态（中继握手链路未上线前，paired 只能来自真实配对握手）
  const handleOneClickConnect = async () => {
    if (!onlineDesktop || connectBusy) return;
    setConnectBusy(true);
    setConnectNotice(null);
    try {
      await cloudAuthStore.getState().requestTicketForDesktop();
      setConnectNotice(
        '中继票据已获取；桌面端中继链路尚未启用，请先使用扫码或手动输入完成配对。'
      );
    } catch (err: unknown) {
      setConnectNotice(
        err instanceof Error
          ? `直连暂不可用：${err.message}`
          : '直连暂不可用：请稍后重试或使用扫码/手动配对。'
      );
    } finally {
      setConnectBusy(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      {onBack ? (
        <View style={styles.header}>
          <HeaderBackButton
            testID="pair-welcome-back"
            accessibilityLabel="返回"
            onPress={onBack}
          />
        </View>
      ) : null}
      <View style={styles.hero}>
        <Text style={[styles.title, { color: theme.textPrimary }]}>
          配对桌面主机
        </Text>
        <Text style={[styles.description, { color: theme.textSecondary }]}>
          在桌面端开启配对模式，然后在手机上输入主机 IP 与配对码即可完成配对。
        </Text>
      </View>

      {/* 云端账号区域 */}
      {isLoggedIn ? (
        <View
          testID="pair-cloud-desktop-card"
          style={[
            styles.cloudCard,
            { backgroundColor: theme.bgCard, borderColor: theme.hairline },
          ]}
        >
          <View style={styles.cloudCardHeader}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: theme.colorSuccess },
              ]}
            />
            <Text style={[styles.cloudCardTitle, { color: theme.textPrimary }]}>
              {onlineDesktop
                ? `发现我的电脑：${onlineDesktop.name}`
                : `已登录 ${userEmail ?? ''}`}
            </Text>
          </View>
          <Text style={[styles.cloudCardDesc, { color: theme.textSecondary }]}>
            {onlineDesktop
              ? '双端已登录同一账号。免扫码直连需桌面端中继链路上线，当前请使用下方扫码或手动输入完成配对。'
              : '正在检测您的在线电脑…请确保电脑端已登录同一账号。'}
          </Text>
          {onlineDesktop ? (
            <Button
              label={connectBusy ? '正在申请直连票据…' : '尝试免扫码直连'}
              testID="pair-one-click-connect"
              onPress={handleOneClickConnect}
              disabled={connectBusy}
              style={styles.cloudConnectBtn}
            />
          ) : null}
          {connectNotice ? (
            <Text
              testID="pair-connect-notice"
              style={[styles.noticeText, { color: theme.colorWarning }]}
            >
              {connectNotice}
            </Text>
          ) : null}
          {cloudError ? (
            <Text style={[styles.errorText, { color: theme.colorError }]}>
              {cloudError}
            </Text>
          ) : null}
        </View>
      ) : (
        <View
          testID="pair-cloud-tip-card"
          style={[
            styles.cloudCard,
            { backgroundColor: theme.bgCard, borderColor: theme.hairline },
          ]}
        >
          <Text style={[styles.cloudCardDesc, { color: theme.textSecondary }]}>
            登录 Flowbit
            账号，手机与电脑开箱即见在线状态（免扫码直连待中继服务上线）。
          </Text>
          {!showLogin ? (
            <Pressable
              testID="pair-open-login"
              hitSlop={dualHitSlop(36, 120)}
              onPress={() => setShowLogin(true)}
              style={styles.openLoginBtn}
            >
              <Text style={[styles.openLoginText, { color: theme.colorInfo }]}>
                立即登录账号
              </Text>
            </Pressable>
          ) : (
            <View testID="pair-cloud-login-box" style={styles.loginBox}>
              <Input
                testID="pair-login-email"
                placeholder="邮箱地址"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
              />
              <Input
                testID="pair-login-password"
                placeholder="登录密码"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
              />
              {cloudError ? (
                <Text style={[styles.errorText, { color: theme.colorError }]}>
                  {cloudError}
                </Text>
              ) : null}
              <View style={styles.loginActions}>
                <Button
                  label={cloudLoading ? '登录中…' : '登录并查找电脑'}
                  testID="pair-login-submit"
                  onPress={handleCloudLogin}
                  disabled={cloudLoading || !email || !password}
                  style={styles.loginBtn}
                />
                <Pressable
                  hitSlop={dualHitSlop(36, 60)}
                  onPress={() => setShowLogin(false)}
                >
                  <Text
                    style={[styles.cancelText, { color: theme.textTertiary }]}
                  >
                    取消
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      )}

      {/* 本地优先兜底操作：手动输入与扫码配对 */}
      <View style={styles.actions}>
        <Button
          label="手动输入配对信息"
          testID="pair-welcome-manual"
          onPress={onOpenManual}
          style={styles.actionBtn}
        />
        <Button
          label="扫码配对"
          variant="secondary"
          testID="pair-welcome-scan"
          onPress={onOpenScan}
          style={styles.actionBtn}
        />
      </View>

      {paired ? (
        <View
          testID="pair-welcome-paired"
          style={[
            styles.pairedCard,
            {
              backgroundColor: theme.bgCard,
              borderColor: theme.hairline,
            },
          ]}
        >
          <Text style={[styles.pairedTitle, { color: theme.textPrimary }]}>
            已配对
          </Text>
          <Text style={[styles.pairedRow, { color: theme.textSecondary }]}>
            主机：{host ?? '—'}
          </Text>
          <Text style={[styles.pairedRow, { color: theme.textSecondary }]}>
            桌面端：{desktopId ?? '—'}
          </Text>
          <Text style={[styles.pairedRow, { color: theme.textSecondary }]}>
            本机：{deviceId ?? '—'}
          </Text>
          <Button
            label="进入应用"
            testID="pair-welcome-enter"
            onPress={onEnterApp}
            style={styles.enterBtn}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  header: {
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  hero: {
    gap: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  description: {
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  cloudCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
    marginTop: 8,
  },
  cloudCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cloudCardTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  cloudCardDesc: {
    fontSize: 13,
    lineHeight: 18,
  },
  cloudConnectBtn: {
    marginTop: 6,
  },
  openLoginBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  openLoginText: {
    fontSize: 13,
    fontWeight: '600',
  },
  loginBox: {
    gap: 8,
    marginTop: 4,
  },
  errorText: {
    fontSize: 12,
  },
  noticeText: {
    fontSize: 12,
    lineHeight: 18,
  },
  loginActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
  },
  loginBtn: {
    flex: 1,
  },
  cancelText: {
    fontSize: 13,
    paddingHorizontal: 8,
  },
  actions: {
    marginTop: 8,
    gap: 12,
  },
  actionBtn: {
    alignSelf: 'stretch',
  },
  pairedCard: {
    marginTop: 16,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 6,
  },
  pairedTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  pairedRow: {
    fontSize: 13,
    lineHeight: 19,
  },
  enterBtn: {
    marginTop: 10,
  },
});
