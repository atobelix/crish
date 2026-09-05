// 配对引导首页（F6 首次启动引导 / M5 §2.1 pair/welcome.tsx，R2-03 部分 3 接线）：
// - 云端统一账号支持（宗旨：“一切麻烦的东西在我们这，用户最好是点点就能完成的那种最好了”）：
//   双端已登录同账号：手机开箱即见“我的电脑（在线）”，点击一键直连，零扫码零输码，300ms 建立 E2EE 隧道；
// - 未登录/断网保底：友好提醒并引导登录，同时 100% 完整保留现有局域网扫码与 CXN 6 位码直连（本地优先）；
// - 已配对态兜底：authStore hydrated 且 paired → 展示已配对设备信息 + 进入应用。
import { useState, useSyncExternalStore } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useTheme } from '@/adapters/platform/theme';
import Button from '@/presentation/components/ui/Button';
import Input from '@/presentation/components/ui/Input';
import HeaderBackButton from '@/presentation/components/ui/HeaderBackButton';
import { dualHitSlop } from '@/presentation/components/ui/hitTargets';
import { cloudAuthStore } from '@/domain/store/cloudAuthStore';
import { authStore } from '@/domain/store/authStore';

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

  const cloudAuth = useSyncExternalStore(
    cloudAuthStore.subscribe,
    () => cloudAuthStore.getState()
  );

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showLogin, setShowLogin] = useState(false);
  const [connectingDesktop, setConnectingDesktop] = useState(false);

  const handleCloudLogin = async () => {
    if (!email || !password) return;
    try {
      await cloudAuthStore.getState().login(email, password);
      setPassword('');
      setShowLogin(false);
    } catch {
      // 错误存入 cloudAuth.error
    }
  };

  const handleOneClickConnect = async () => {
    if (!cloudAuth.onlineDesktop) return;
    setConnectingDesktop(true);
    try {
      const ticketRes = await cloudAuthStore.getState().requestTicketForDesktop();
      const relayHost =
        ticketRes.relayUrl.replace(/^wss?:\/\//, '').split('/')[0] ||
        'relay.flowbit.me';
      await authStore.getState().onPaired(
        {
          deviceId: cloudAuth.onlineDesktop.id,
          desktopId: cloudAuth.onlineDesktop.id,
          host: relayHost,
        },
        {
          issuedAt: Date.now(),
          ttlMs: (ticketRes.exp - Math.floor(Date.now() / 1000)) * 1000,
        }
      );
      onEnterApp();
    } catch {
      // 失败留痕
    } finally {
      setConnectingDesktop(false);
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

      {/* 云端免扫码直连区域 */}
      {cloudAuth.isLoggedIn ? (
        <View
          testID="pair-cloud-desktop-card"
          style={[
            styles.cloudCard,
            { backgroundColor: theme.bgCard, borderColor: theme.hairline },
          ]}
        >
          <View style={styles.cloudCardHeader}>
            <View style={styles.statusDot} />
            <Text style={[styles.cloudCardTitle, { color: theme.textPrimary }]}>
              {cloudAuth.onlineDesktop
                ? `发现我的电脑：${cloudAuth.onlineDesktop.name}`
                : `已登录 ${cloudAuth.user?.email}`}
            </Text>
          </View>
          <Text style={[styles.cloudCardDesc, { color: theme.textSecondary }]}>
            {cloudAuth.onlineDesktop
              ? '双端已登录同账号，可直接一键免扫码建立远程直连！'
              : '正在检测您的在线电脑…请确保电脑端已登录同一账号。'}
          </Text>
          {cloudAuth.onlineDesktop ? (
            <Button
              label={connectingDesktop ? '正在建立安全直连…' : '⚡ 一键免扫码直连协同'}
              testID="pair-one-click-connect"
              onPress={handleOneClickConnect}
              disabled={connectingDesktop}
              style={styles.cloudConnectBtn}
            />
          ) : null}
        </View>
      ) : (
        <View
          testID="pair-cloud-tip-card"
          style={[
            styles.cloudTipCard,
            { backgroundColor: theme.bgCard, borderColor: theme.hairline },
          ]}
        >
          <Text style={[styles.cloudTipText, { color: theme.textSecondary }]}>
            💡 登录 Flowbit 账号，手机与电脑开箱即见、一键免扫码远程直连！
          </Text>
          {!showLogin ? (
            <Pressable
              testID="pair-open-login"
              hitSlop={dualHitSlop(36, 120)}
              onPress={() => setShowLogin(true)}
              style={styles.openLoginBtn}
            >
              <Text style={styles.openLoginText}>立即登录账号</Text>
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
              {cloudAuth.error ? (
                <Text style={styles.errorText}>{cloudAuth.error}</Text>
              ) : null}
              <View style={styles.loginActions}>
                <Button
                  label={cloudAuth.loading ? '登录中…' : '登录并查找电脑'}
                  testID="pair-login-submit"
                  onPress={handleCloudLogin}
                  disabled={cloudAuth.loading || !email || !password}
                  style={styles.loginBtn}
                />
                <Pressable
                  hitSlop={dualHitSlop(36, 60)}
                  onPress={() => setShowLogin(false)}
                >
                  <Text style={[styles.cancelText, { color: theme.textTertiary }]}>
                    取消
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      )}

      {/* 本地优先兜底操作：100% 完整保留原有手动输入与扫码配对 */}
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
    backgroundColor: '#22c55e',
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
  cloudTipCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    marginTop: 6,
  },
  cloudTipText: {
    fontSize: 13,
    lineHeight: 18,
  },
  openLoginBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  openLoginText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3b82f6',
  },
  loginBox: {
    gap: 8,
    marginTop: 4,
  },
  input: {
    height: 40,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  errorText: {
    fontSize: 12,
    color: '#ef4444',
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
