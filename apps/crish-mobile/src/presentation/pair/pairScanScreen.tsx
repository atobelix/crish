// 扫码配对：相机取景 + QR 解析 + 发起配对。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '@/adapters/hooks/useAppStore';
import { useTheme } from '@/adapters/platform/theme';
import { parseQrPayload } from '@/pairing/qrPayload';
import {
  AppText,
  Button,
  EmptyState,
  IconButton,
  Spinner,
  useToast,
} from '@/presentation/ui';
import {
  ensurePairingController,
  type PairingController,
} from '@/adapters/pairing/pairingController';
import { pairFailureText } from './pairingCopy';

export interface PairScanScreenProps {
  onClose: () => void;
  onPaired: () => void;
}

export default function PairScanScreen({
  onClose,
  onPaired,
}: PairScanScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const pairState = useAuthStore((s) => s.pairState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<PairingController | null>(null);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const controller = useCallback((): PairingController => {
    if (!controllerRef.current) {
      controllerRef.current = ensurePairingController();
    }
    return controllerRef.current;
  }, []);

  useEffect(() => {
    if (pairState === 'paired') onPaired();
  }, [pairState, onPaired]);

  useEffect(() => {
    const instance = controller();
    return instance.subscribe(() => {
      const snapshot = instance.getSnapshot();
      if (snapshot.machine.state === 'paired') {
        onPaired();
        return;
      }
      const failure = pairFailureText(snapshot);
      if (failure) {
        setBusy(false);
        setError(failure);
      }
    });
  }, [controller, onPaired]);

  useEffect(
    () => () => {
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
    },
    []
  );

  const handleScan = (data: string) => {
    if (busy) return;
    const parsed = parseQrPayload(data);
    if (!parsed.ok) {
      toast.showToast('不是有效的配对二维码', 'error');
      setBusy(true);
      resumeTimer.current = setTimeout(() => setBusy(false), 1500);
      return;
    }
    setBusy(true);
    setError(null);
    const result = controller().beginPairing({
      host: parsed.data.host,
      port: parsed.data.port,
      code: parsed.data.code,
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.error ?? '无法开始配对');
    }
  };

  if (!permission) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.colors.canvas }]}>
        <Spinner centered />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.colors.canvas }]}>
        <View style={[styles.permissionHeader, { paddingTop: insets.top }]}>
          <IconButton name="x" accessibilityLabel="关闭" onPress={onClose} />
        </View>
        <EmptyState
          icon="qr-code"
          title="需要相机权限"
          action={
            <Button
              label={permission.canAskAgain ? '允许使用相机' : '去设置'}
              onPress={() => {
                if (permission.canAskAgain) {
                  void requestPermission();
                } else {
                  void Linking.openSettings();
                }
              }}
            />
          }
        />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={
          busy
            ? undefined
            : ({ data }: BarcodeScanningResult) => handleScan(data)
        }
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.topBar, { paddingTop: insets.top + 4 }]}>
          <IconButton
            name="x"
            accessibilityLabel="关闭扫码"
            onPress={onClose}
          />
        </View>
        <View style={styles.frameArea} pointerEvents="none">
          <View
            style={[
              styles.frame,
              {
                borderRadius: theme.radius.lg,
                borderColor: theme.colors.brand,
              },
            ]}
          />
          <AppText variant="footnote" color="onMedia">
            {busy ? '正在连接…' : '对准桌面端二维码'}
          </AppText>
          {error ? (
            <AppText
              variant="footnote"
              color="onMediaDanger"
              style={styles.error}
            >
              {error}
            </AppText>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  permissionHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
  },
  frameArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  frame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    backgroundColor: 'transparent',
  },
  error: {
    paddingHorizontal: 24,
    textAlign: 'center',
  },
});
