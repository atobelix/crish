// 连接设备 Sheet（纯净极简重塑）：
// - 严格遵循用户裁决：“只有一个设备名称即可，最多加上一个扫码添加新设备。像是多余的文字一点也不要有。”
// - 彻底剔除多行冗长空态说明（“暂无已知电脑”、“登录同一账号...”）；
// - 彻底移除副标题提示文案（如“当前设备”）；
// - 全行透明无底色（Transparent），仅保留选中对号与扫码入口。
// - 账号模式：列出本账号的已知设备目录（relay 发现的在线桌面 + 历史已知
//   的离线桌面灰置），点选在线设备即切换控制目标；
// - 「本机」行恒在首位；
// - 扫码添加新设备行常驻于列表末尾。
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { Sheet, SheetOptionRow } from '@/presentation/ui';
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

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="连接设备"
      size="large"
      testID={testID}
    >
      <View style={[styles.list, { gap: theme.space.xxs }]}>
        <SheetOptionRow
          testID="device-sheet-local"
          label={device.localDevice.name}
          selected={device.localDevice.selected}
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
            {device.devices.map((row) => (
              <SheetOptionRow
                key={row.id}
                testID={`device-sheet-device-${row.id}`}
                label={row.name}
                selected={row.isTarget}
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
            ))}
          </>
        ) : null}
        {showPairedRow ? (
          <SheetOptionRow
            testID="device-sheet-current"
            label={pairedHost ?? '已配对桌面'}
            selected={!device.localDevice.selected}
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
});

export default DeviceSheet;
