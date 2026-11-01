// 连接设备 Sheet（原型 cloud-pc 面板的诚实化映射）：
// 移动端同一时刻只有一台配对桌面（多设备列表为原型 mock，不移植）——
// 行 = 当前配对桌面（在线状态 + 点击重连）；动作 = 扫码添加新设备。
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
  const statusHint = device.connected ? '在线' : device.phaseLabel;
  return (
    <Sheet visible={visible} onClose={onClose} title="连接设备" testID={testID}>
      <SheetOptionRow
        testID="device-sheet-current"
        label={device.host ?? '已配对桌面'}
        selected
        hint={statusHint}
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
    </Sheet>
  );
}

export default DeviceSheet;
