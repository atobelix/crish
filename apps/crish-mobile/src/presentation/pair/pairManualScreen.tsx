// 手动配对页（D4 §5.1 / R2-03 部分 3）：主机 IP + CXN 配对码 → 接线层配对
// - 配对码输入实时格式化（CXN-XXXX-XXXX-XXXX 展示形态，formatPairCodeDraft——
//   前缀剥离与 cxnCode.normalizePairCode 同语义：清理后 >12 位且以 CXN 起头
//   才剥；原始输入保留，提交由接线层 normalizePairCode 权威校验）；
// - 实时校验：normalizePairCode（提示仅非法且非空时展示，不打扰输入）；
// - 提交：pairingWiring.beginPairing({host, code})——本地校验/状态拒绝同步
//   返回 ok:false → 错误文案映射（可改码重试）；成功后接线层收口
//   （persist + authStore paired）→ (tabs) AuthGuard 自动放行；
// - 配对中 busy：机器态 sending-hello/waiting-verify（按钮 loading + 提交锁
//   防双点，F2 §9.3-3 语义）；
// - 失败错误码映射：PAIR_ERROR_TEXT（pair.invalid_code / pair.too_many_attempts
//   / pairing.transport_failed 等 → 人话文案）；locked → 冷却提示；
// - 返回放弃确认（A4 裁决）：输入脏（host/码非空或配对中）→ 返回弹 Dialog
//   （取消保留 / 放弃配对：重置在途配对 + onBack）；Android 硬件返回键同拦截；
// - 连接状态展示：connectionStore 相位标签（M5 §4.3.1 标签表；配对期相位
//   disconnected 不展示，会话连接后展示 连接中/已连接 等）。
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import {
  normalizePairCode,
  PAIR_CODE_GROUP_SIZE,
  PAIR_CODE_LENGTH,
  PAIR_CODE_PREFIX,
  PAIR_CODE_SEPARATOR,
} from '@/pairing/cxnCode';
import type {
  PairingSnapshot,
  PairingStartResult,
} from '@/adapters/wiring/pairingWiring';
import { useConnectionStore } from '@/adapters/hooks/useAppStore';
import { selectConnectionPhaseText } from '@/domain/store/connectionStore';
import { useAppTheme, useThemeMode } from '@/adapters/settings/themeProjection';
import Button from '@/presentation/components/ui/Button';
import Dialog from '@/presentation/components/ui/Dialog';
import type { DialogAction } from '@/presentation/components/ui/Dialog';
import {
  ensurePairingController,
  type PairingController,
} from './pairingBootstrap';

/** 配对码展示形态长度（CXN-XXXX-XXXX-XXXX = 19） */
export const PAIR_CODE_DISPLAY_MAX_LENGTH = 19;

/** 放弃确认（A4 裁决：有输入丢失风险的返回需 Dialog 确认） */
export const PAIR_ABANDON_DIALOG_TITLE = '放弃配对？';
export const PAIR_ABANDON_DIALOG_DESCRIPTION =
  '当前输入的配对信息尚未提交，返回后将丢失，需要重新输入。';

/** 锁定冷却提示（本地/服务端失败次数达上限，D3 §4.3） */
export const PAIR_LOCKED_TEXT =
  '尝试次数过多，请在桌面端重新开启配对（冷却 5 分钟）';

// 焦点边框（R2UX §13：焦点态须可见但柔软——hairlineStrong 向 textPrimary
// 混入约 6%，不取深黑实线；token 面无焦点专用项，本处按规范量级落地）
const FOCUS_BORDER_LIGHT = 'hsl(35,10%,81%)';
const FOCUS_BORDER_DARK = 'hsl(0,0%,23%)';

/** wire/接线错误码 → 人话文案（D3 §6.2 pair.* 全表 + 接线层本地码） */
export const PAIR_ERROR_TEXT: Record<string, string> = {
  'pair.invalid_code': '配对码无效，请检查后重试',
  'pair.expired': '配对码已过期（10 分钟有效），请在桌面端重新开启配对',
  'pair.used': '配对码已被使用，请重新获取配对码',
  'pair.too_many_attempts': '尝试次数过多，请稍后（5 分钟）再试',
  'pair.challenge_mismatch': '配对验证失败（挑战签名不匹配），请重试',
  'pair.no_challenge': '配对验证失败（无对应挑战），请重试',
  'pair.registry_full':
    '桌面端设备数已达上限（默认 8 台），请先在桌面端移除设备',
  'pair.key_agreement_failed': '密钥协商失败，请重试',
  'pair.key_material_missing': '密钥协商材料不完整，请重试',
  'pairing.transport_failed': '无法连接桌面主机，请检查主机 IP 与网络后重试',
  'pairing.persist_failed': '配对信息保存失败，请重试',
  'pairing.stale_credential': '配对凭据不完整，已清理，请重新配对',
  'pairing.bad_challenge': '配对响应异常（challenge 解析失败），请重试',
  'pairing.bad_ok': '配对响应异常（ok 解析失败），请重试',
  'pairing.internal': '配对流程内部错误，请重试',
};

/** 错误码 → 文案（未知码兜底文案；纯函数，单测面） */
export function pairErrorText(
  code: string,
  fallback = '配对失败，请重试'
): string {
  return PAIR_ERROR_TEXT[code] ?? fallback;
}

/** 接线快照 → 失败文案（error 态按错误码映射；locked 恒冷却提示；其余 null） */
export function pairFailureText(snap: PairingSnapshot): string | null {
  const m = snap.machine;
  if (m.state === 'error') {
    return pairErrorText(m.error?.code ?? snap.error?.code ?? '');
  }
  if (m.state === 'locked') return PAIR_LOCKED_TEXT;
  return null;
}

/**
 * 配对码输入实时格式化（展示形态 CXN-XXXX-XXXX-XXXX）：
 * - 大写 + 过滤非法字符 + 分组 4 位加分隔符，长度截断 12 位；
 * - 前缀剥离与 cxnCode.normalizePairCode 同语义：清理后 >12 位且以 CXN
 *   起头才剥（12 位裸码以 CXN 起头属正常码，不剥）；
 * - 仅展示形态；原始输入保留，提交时 normalizePairCode 权威校验。
 */
export function formatPairCodeDraft(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body =
    cleaned.length > PAIR_CODE_LENGTH && cleaned.startsWith('CXN')
      ? cleaned.slice('CXN'.length)
      : cleaned;
  const capped = body.slice(0, PAIR_CODE_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < capped.length; i += PAIR_CODE_GROUP_SIZE) {
    groups.push(capped.slice(i, i + PAIR_CODE_GROUP_SIZE));
  }
  return groups.length > 0
    ? `${PAIR_CODE_PREFIX}${groups.join(PAIR_CODE_SEPARATOR)}`
    : '';
}

export interface PairManualScreenProps {
  /** 配对控制器（缺省 = 接线单例 ensurePairingController；测试注入 fake） */
  controller?: PairingController;
  /** 返回（放弃确认通过后调用；页面层接 router.back()） */
  onBack: () => void;
}

export default function PairManualScreen({
  controller: controllerProp,
  onBack,
}: PairManualScreenProps) {
  const theme = useAppTheme();
  const controller = useMemo(
    () => controllerProp ?? ensurePairingController(),
    [controllerProp]
  );
  const [snap, setSnap] = useState<PairingSnapshot>(() =>
    controller.getSnapshot()
  );
  useEffect(
    () => controller.subscribe(() => setSnap(controller.getSnapshot())),
    [controller]
  );

  const [host, setHost] = useState('');
  const [codeRaw, setCodeRaw] = useState('');
  const [focusedField, setFocusedField] = useState<'host' | 'code' | null>(
    null
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const submittingRef = useRef(false);

  const phase = useConnectionStore((s) => s.phase);

  const machine = snap.machine;
  const busy =
    machine.state === 'sending-hello' || machine.state === 'waiting-verify';
  const codeCheck = normalizePairCode(codeRaw);
  const codeValid = codeCheck.ok;
  const codeHint = codeCheck.ok ? null : codeCheck.error;
  const dirty = host.trim() !== '' || codeRaw.trim() !== '' || busy;
  const displayError = localError ?? pairFailureText(snap);
  const canConnect = host.trim() !== '' && codeValid && !busy;

  // 机器离开配对中 → 提交锁复位（防双点；按钮 loading 由 busy 驱动）
  useEffect(() => {
    if (!busy) submittingRef.current = false;
  }, [busy]);

  const onSubmit = () => {
    if (busy || submittingRef.current) return;
    submittingRef.current = true;
    setLocalError(null);
    const result: PairingStartResult = controller.beginPairing({
      host: host.trim(),
      code: codeRaw,
    });
    if (!result.ok) {
      submittingRef.current = false;
      setLocalError(result.error ?? '配对失败，请重试');
    }
  };

  const handleBack = () => {
    if (dirty) {
      setConfirmOpen(true);
      return;
    }
    onBack();
  };

  // Android 硬件返回键：脏输入拦截（A4 裁决；干净 → 交还系统默认返回）
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dirty) {
        setConfirmOpen(true);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [dirty]);

  const handleConfirmLeave = () => {
    setConfirmOpen(false);
    if (busy) controller.reset(); // 放弃在途配对（断开配对期连接 + 机器复位）
    onBack();
  };

  const abandonActions: DialogAction[] = [
    {
      label: '取消',
      variant: 'secondary',
      onPress: () => setConfirmOpen(false),
      testID: 'pair-abandon-cancel',
    },
    {
      label: '放弃配对',
      variant: 'primary',
      onPress: handleConfirmLeave,
      testID: 'pair-abandon-confirm',
    },
  ];

  // 焦点边框（R2UX §13：焦点态可见但柔软，hairlineStrong 向 textPrimary 约 6% 混入）；
  // 有效配色 = 主题三选投影（跟随系统时取系统外观，对齐 themeProjection 语义）
  const themeMode = useThemeMode((s) => s.mode);
  const systemScheme = useColorScheme();
  const effectiveDark =
    themeMode === 'dark' || (themeMode === 'system' && systemScheme === 'dark');
  const focusBorder = effectiveDark ? FOCUS_BORDER_DARK : FOCUS_BORDER_LIGHT;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
        <View style={styles.header}>
          <Pressable
            testID="pair-manual-back"
            accessibilityRole="button"
            accessibilityLabel="返回"
            onPress={handleBack}
            style={styles.backBtn}
          >
            <Text style={[styles.backText, { color: theme.textSecondary }]}>
              ‹ 返回
            </Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.textPrimary }]}>
            手动配对
          </Text>
        </View>

        <TextInput
          testID="pair-host-input"
          style={[
            styles.input,
            {
              borderColor:
                focusedField === 'host' ? focusBorder : theme.hairlineStrong,
              color: theme.textPrimary,
            },
          ]}
          placeholder="主机 IP / 主机名"
          placeholderTextColor={theme.textTertiary}
          value={host}
          onChangeText={setHost}
          onFocus={() => setFocusedField('host')}
          onBlur={() => setFocusedField(null)}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="主机 IP 或主机名"
        />
        <TextInput
          testID="pair-code-input"
          style={[
            styles.input,
            {
              borderColor:
                focusedField === 'code' ? focusBorder : theme.hairlineStrong,
              color: theme.textPrimary,
            },
          ]}
          placeholder="配对码（CXN-XXXX-XXXX-XXXX）"
          placeholderTextColor={theme.textTertiary}
          value={formatPairCodeDraft(codeRaw)}
          onChangeText={setCodeRaw}
          onFocus={() => setFocusedField('code')}
          onBlur={() => setFocusedField(null)}
          maxLength={PAIR_CODE_DISPLAY_MAX_LENGTH}
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel="配对码"
        />
        {codeRaw.trim() !== '' && !codeValid ? (
          <Text
            testID="pair-code-hint"
            style={[styles.hint, { color: theme.textSecondary }]}
          >
            {codeHint ?? '配对码格式不正确'}
          </Text>
        ) : null}

        {displayError ? (
          <View
            testID="pair-error"
            style={[
              styles.errorBanner,
              { backgroundColor: theme.colorErrorBg },
            ]}
          >
            <Text style={[styles.errorText, { color: theme.colorError }]}>
              {displayError}
            </Text>
          </View>
        ) : null}

        {phase !== 'disconnected' ? (
          <Text
            testID="pair-phase"
            style={[styles.phase, { color: theme.textSecondary }]}
          >
            连接状态：{selectConnectionPhaseText(phase)}
          </Text>
        ) : null}

        <Button
          label={busy ? '配对中…' : '连接'}
          testID="pair-connect"
          onPress={onSubmit}
          disabled={!canConnect}
          loading={busy}
          style={styles.connectBtn}
        />

        <Dialog
          visible={confirmOpen}
          title={PAIR_ABANDON_DIALOG_TITLE}
          description={PAIR_ABANDON_DIALOG_DESCRIPTION}
          testID="pair-abandon-dialog"
          actions={abandonActions}
          onDismiss={() => setConfirmOpen(false)}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    padding: 24,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  backBtn: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
  },
  backText: {
    fontSize: 15,
  },
  title: {
    flex: 1,
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
    marginRight: 44,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  hint: {
    fontSize: 12,
    lineHeight: 18,
  },
  errorBanner: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 19,
  },
  phase: {
    fontSize: 13,
  },
  connectBtn: {
    marginTop: 8,
    alignSelf: 'stretch',
  },
});
