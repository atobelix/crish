// 连接设备 Sheet（G4 多设备切换）：
// - 账号模式：列出本账号的已知设备目录（relay 发现的在线桌面 + 历史已知
//   的离线桌面灰置），点选在线设备即切换控制目标——切换经票据重连真实
//   生效（accountRuntime 按 targetDeviceId 重建接线并清空旧主机会话面），
//   不是只改选中态。当前目标带对号；目标行在未连通时点击 = 重连。
// - 局域网配对行：中继未接管且已配对时呈现（= 历史单设备形态，语义不变）；
//   中继接管后配对行让位账号设备行，避免把非当前连接误报为当前设备。
// - 「本机」行恒在首位（手机自身 = 本地模式）：账号模式点选即清目标 +
//   本地钉住（真实切换，不是只改选中态）；本地生效时呈选中态。非账号模式
//   且远端在效时点选 = 「现在用本地」导航（onUseLocal），不解绑配对。
// - 扫码添加新设备行两种模式都在（配对新桌面走既有扫码链）。
// 行距按原型 sheet-clean-list 的 6；「在线」按原型 device-status-text 纯绿字内联呈现。
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Sheet, SheetOptionRow } from '@/presentation/ui';
import type { DeviceStatusVm } from '@/adapters/viewmodels/useDeviceStatusVm';

export interface DeviceSheetProps {
  visible: boolean;
  onClose: () => void;
  device: DeviceStatusVm;
  /** 扫码添加新设备（→ /pair/scan） */
  onOpenScan: () => void;
  /** 非账号模式点「本机」且远端在效时：「现在用本地」（导航本地对话页） */
  onUseLocal?: () => void;
  testID?: string;
}

export function DeviceSheet({
  visible,
  onClose,
  device,
  onOpenScan,
  onUseLocal,
  testID,
}: DeviceSheetProps) {
  const theme = useTheme();
  const { accountMode, relayEngaged, pairedHost, refreshDevices } = device;

  // 打开 Sheet 时补一轮设备发现，让在线状态尽量新（发现心跳为 15s 周期）。
  // refreshDevices 在 VM 内为 useCallback 稳定引用，依赖它不会重复触发。
  useEffect(() => {
    if (visible && accountMode) refreshDevices();
  }, [visible, accountMode, refreshDevices]);

  const showPairedRow = pairedHost !== null && !relayEngaged;
  const pairedHint = device.connected ? '在线' : device.phaseLabel;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="连接设备"
      size="large"
      testID={testID}
    >
      <View style={[styles.list, { gap: theme.space.xs + theme.space.xxs }]}>
        <SheetOptionRow
          testID="device-sheet-local"
          label={device.localDevice.name}
          selected={device.localDevice.selected}
          hint={device.localDevice.selected ? '当前设备' : undefined}
          onPress={() => {
            if (accountMode) {
              device.switchToLocal();
              onClose();
              return;
            }
            onClose();
            if (!device.localDevice.selected) onUseLocal?.();
          }}
        />
        {accountMode ? (
          <>
            {device.devices.length === 0 ? (
              <View style={styles.empty}>
                <AppText variant="body" color="textSecondary">
                  暂无已知电脑
                </AppText>
                <AppText
                  variant="caption"
                  color="textTertiary"
                  style={styles.emptyText}
                >
                  登录同一账号的电脑将显示在此
                </AppText>
              </View>
            ) : (
              device.devices.map((row) => {
                const hint = row.isTarget
                  ? device.connected
                    ? '在线'
                    : row.online
                      ? device.phaseLabel
                      : '离线'
                  : row.online
                    ? '在线'
                    : '离线';
                const hintIsSuccess =
                  row.online && (!row.isTarget || device.connected);
                return (
                  <SheetOptionRow
                    key={row.id}
                    testID={`device-sheet-device-${row.id}`}
                    label={row.name}
                    selected={row.isTarget}
                    hint={hint}
                    hintTone={hintIsSuccess ? 'success' : 'muted'}
                    disabled={!row.online}
                    onPress={() => {
                      if (row.isTarget) {
                        if (!device.connected) device.reconnect();
                      } else {
                        device.switchDevice(row.id);
                      }
                      onClose();
                    }}
                  />
                );
              })
            )}
          </>
        ) : null}
        {showPairedRow ? (
          <SheetOptionRow
            testID="device-sheet-current"
            label={pairedHost ?? '已配对桌面'}
            selected={!device.localDevice.selected}
            hint={pairedHint}
            hintTone={device.connected ? 'success' : 'muted'}
            onPress={() => {
              if (!device.connected) device.reconnect();
              onClose();
            }}
          />
        ) : null}
        <SheetOptionRow
          testID="device-sheet-scan"
          label="扫码添加新设备"
          showChevron
          onPress={() => {
            onClose();
            onOpenScan();
          }}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: {
    flexDirection: 'column',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  emptyText: {
    textAlign: 'center',
  },
});

export default DeviceSheet;
