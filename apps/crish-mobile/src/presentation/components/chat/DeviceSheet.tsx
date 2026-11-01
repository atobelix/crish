// 连接设备 Sheet（原型 cloud-pc 面板的诚实化映射）：
// 移动端同一时刻只有一台配对桌面（多设备列表为原型 mock，不移植）——
// 行 = 当前配对桌面（在线状态 + 点击重连）；动作 = 扫码添加新设备。
// 行距按原型 sheet-clean-list 的 6；「在线」按原型 device-status-text 纯绿字内联呈现。
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
  testID?: string;
}

export function DeviceSheet({
  visible,
  onClose,
  device,
  onOpenScan,
  testID,
}: DeviceSheetProps) {
  const theme = useTheme();
  const statusHint = device.connected ? '在线' : device.phaseLabel;
  return (
    <Sheet visible={visible} onClose={onClose} title="连接设备" testID={testID}>
      <View style={[styles.list, { gap: theme.space.xs + theme.space.xxs }]}>
        <SheetOptionRow
          testID="device-sheet-current"
          label={device.host ?? '已配对桌面'}
          selected
          hint={statusHint}
          hintTone={device.connected ? 'success' : 'muted'}
          onPress={() => {
            if (!device.connected) device.reconnect();
            onClose();
          }}
        />
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
