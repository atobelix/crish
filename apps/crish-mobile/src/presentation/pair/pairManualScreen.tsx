// 手动配对：主机 + 配对码（可选端口）。
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import {
  extractCodeFromDraft,
  normalizePairCode,
  PAIR_CODE_GROUP_SIZE,
  PAIR_CODE_LENGTH,
  PAIR_CODE_PREFIX,
  PAIR_CODE_SEPARATOR,
} from '@/domain/pure/cxnCode';
import type {
  PairingSnapshot,
  PairingStartResult,
} from '@/adapters/pairing/pairingController';
import { DEFAULT_GATEWAY_PORT } from '@/network/EndpointResolver';
import {
  AppHeader,
  AppText,
  Button,
  Dialog,
  Input,
  Screen,
} from '@/presentation/ui';
import type { DialogAction } from '@/presentation/ui';
import {
  ensurePairingController,
  type PairingController,
} from '@/adapters/pairing/pairingController';
import { ConnectionHelpSheet } from '@/presentation/components/status/ConnectionHelpSheet';
import {
  PAIR_ABANDON_DIALOG_DESCRIPTION,
  PAIR_ABANDON_DIALOG_TITLE,
  pairFailureText,
} from './pairingCopy';

export const PAIR_CODE_DISPLAY_MAX_LENGTH = 19;

export { PAIR_ABANDON_DIALOG_TITLE, PAIR_ABANDON_DIALOG_DESCRIPTION };

export function formatPairCodeDraft(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body =
    cleaned.length > PAIR_CODE_LENGTH && cleaned.startsWith('CXN')
      ? cleaned.slice('CXN'.length)
      : cleaned;
  const capped = body.slice(0, PAIR_CODE_LENGTH);
  const groups: string[] = [];
  for (let index = 0; index < capped.length; index += PAIR_CODE_GROUP_SIZE) {
    groups.push(capped.slice(index, index + PAIR_CODE_GROUP_SIZE));
  }
  return groups.length > 0
    ? `${PAIR_CODE_PREFIX}${groups.join(PAIR_CODE_SEPARATOR)}`
    : '';
}

export interface PairManualScreenProps {
  controller?: PairingController;
  onBack: () => void;
}

export default function PairManualScreen({
  controller: controllerProp,
  onBack,
}: PairManualScreenProps) {
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
  const [portText, setPortText] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const submittingRef = useRef(false);

  const machine = snap.machine;
  const busy =
    machine.state === 'sending-hello' || machine.state === 'waiting-verify';
  const codeCheck = normalizePairCode(codeRaw);
  const codeValid = codeCheck.ok;
  const port = portText.trim() === '' ? DEFAULT_GATEWAY_PORT : Number(portText);
  const portValid = Number.isInteger(port) && port > 0 && port < 65536;
  const dirty = host.trim() !== '' || codeRaw.trim() !== '' || busy;
  const error = localError ?? pairFailureText(snap);
  const canConnect = host.trim() !== '' && codeValid && portValid && !busy;

  useEffect(() => {
    if (!busy) submittingRef.current = false;
  }, [busy]);

  const onSubmit = () => {
    if (!canConnect || submittingRef.current) return;
    submittingRef.current = true;
    setLocalError(null);
    const result: PairingStartResult = controller.beginPairing({
      host: host.trim(),
      code: codeRaw,
      port,
    });
    if (!result.ok) {
      submittingRef.current = false;
      setLocalError(result.error ?? '无法开始配对');
    }
  };

  const handleBack = () => {
    if (dirty) {
      setConfirmOpen(true);
      return;
    }
    onBack();
  };

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (dirty) {
          setConfirmOpen(true);
          return true;
        }
        return false;
      }
    );
    return () => subscription.remove();
  }, [dirty]);

  const abandonActions: DialogAction[] = [
    {
      label: '取消',
      variant: 'secondary',
      onPress: () => setConfirmOpen(false),
      testID: 'pair-abandon-cancel',
    },
    {
      label: '放弃',
      variant: 'danger',
      onPress: () => {
        setConfirmOpen(false);
        if (busy) controller.reset();
        onBack();
      },
      testID: 'pair-abandon-confirm',
    },
  ];

  return (
    <Screen avoidKeyboard>
      <AppHeader title="手动连接" onBack={handleBack} />
      <View style={styles.content}>
        <Input
          testID="pair-host-input"
          label="主机"
          placeholder="IP 地址或主机名"
          value={host}
          onChangeText={setHost}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Input
          testID="pair-code-input"
          label="配对码"
          placeholder="CXN-XXXX-XXXX-XXXX"
          value={formatPairCodeDraft(codeRaw)}
          onChangeText={(text) => setCodeRaw(extractCodeFromDraft(text))}
          maxLength={PAIR_CODE_DISPLAY_MAX_LENGTH}
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="高级设置"
          accessibilityState={{ expanded: advanced }}
          onPress={() => setAdvanced((value) => !value)}
          style={styles.advancedToggle}
        >
          <AppText variant="footnote" color="textSecondary">
            {advanced ? '收起高级设置' : '高级设置'}
          </AppText>
        </Pressable>
        {advanced ? (
          <Input
            testID="pair-port-input"
            label="端口"
            placeholder={String(DEFAULT_GATEWAY_PORT)}
            value={portText}
            onChangeText={setPortText}
            keyboardType="number-pad"
            error={!portValid ? '端口需在 1-65535 之间' : undefined}
          />
        ) : null}
        {codeRaw.trim() !== '' && !codeValid ? (
          <AppText variant="footnote" color="danger" testID="pair-code-hint">
            {codeCheck.error ?? '配对码格式不正确'}
          </AppText>
        ) : null}
        {error ? (
          <AppText variant="footnote" color="danger" testID="pair-error">
            {error}
          </AppText>
        ) : null}
        <Button
          label={busy ? '正在配对…' : '连接'}
          testID="pair-connect"
          onPress={onSubmit}
          disabled={!canConnect}
          loading={busy}
          style={styles.connect}
        />
        <AppText variant="caption" color="textTertiary" style={styles.hint}>
          在桌面端「设置 → 多端互通」中开启配对，可扫码或复制配对码。
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="查看连接帮助"
          onPress={() => setHelpOpen(true)}
          style={styles.helpButton}
        >
          <AppText variant="footnote" color="textSecondary">
            连接遇到问题？
          </AppText>
        </Pressable>
      </View>
      <ConnectionHelpSheet
        visible={helpOpen}
        onClose={() => setHelpOpen(false)}
      />
      <Dialog
        visible={confirmOpen}
        title={PAIR_ABANDON_DIALOG_TITLE}
        description={PAIR_ABANDON_DIALOG_DESCRIPTION}
        testID="pair-abandon-dialog"
        actions={abandonActions}
        onDismiss={() => setConfirmOpen(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 20,
    gap: 16,
  },
  advancedToggle: {
    alignSelf: 'flex-start',
    minHeight: 32,
    justifyContent: 'center',
  },
  connect: {
    marginTop: 4,
  },
  hint: {
    marginTop: 4,
  },
  helpButton: {
    alignSelf: 'flex-start',
    minHeight: 32,
    justifyContent: 'center',
  },
});
