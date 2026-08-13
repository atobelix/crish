// 移除本机危险区（R2UX-06-06 双保险：Dialog 确认（标题+后果+危险主按钮+取消）、
// 焦点不落危险按钮；M5 §6.2 移除本机语义）：
// - 触发：底部危险区「移除本机」按钮（红底 danger，M4 §6.3 危险操作分级）；
// - 双保险：Dialog 标题 + 后果说明（解除配对/清空本地数据/需重新配对）+
//   danger 主按钮 + 取消（遮罩点击/Esc 等价取消，Dialog 内置 onDismiss）；
// - 焦点初始落取消：actions 顺序「取消在前、移除本机在后」——RN 无自动聚焦，
//   平台首个可聚焦元素/读屏顺序即取消，危险按钮不落初始焦点（R2UX-06-06）；
// - 防双点：确认后关闭弹窗 → removing busy（按钮 loading + 禁用），重复触发
//   被 guard 拦截（F2 §9.3-3 防双点语义；Dialog 原子组件未暴露 busy 注入面，
//   由本层逻辑 guard 兜底）；onConfirm 成功与否由页面层决定重定向。
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import type { DialogAction } from '../ui/Dialog';
import { useAppTheme } from '@/adapters/settings/themeProjection';

export const REMOVE_LOCAL_DIALOG_TITLE = '移除本机';

/** 后果说明（M4 §6.3 文案模板：操作名 + 对象 + 后果；含解除配对/清空本地数据/需重新配对） */
export const REMOVE_LOCAL_DIALOG_DESCRIPTION =
  '将解除本机与桌面端的配对，清空本机的配对数据与登录状态；移除后需重新配对才能连接。';

/**
 * 双保险确认 actions（纯函数，单测面）：取消在前（焦点/读屏初始落取消）、
 * 危险主按钮在后（R2UX-06-06 焦点不落危险按钮）。
 */
export function removeLocalDialogActions(
  onConfirm: () => void,
  onCancel: () => void
): DialogAction[] {
  return [
    {
      label: '取消',
      variant: 'secondary',
      onPress: onCancel,
      testID: 'settings-remove-cancel',
    },
    {
      label: REMOVE_LOCAL_DIALOG_TITLE,
      variant: 'danger',
      onPress: onConfirm,
      testID: 'settings-remove-confirm',
    },
  ];
}

export interface SettingsRemoveLocalZoneProps {
  /** 确认回调（页面层接 unpair + 重定向；async 时本层展示 removing busy） */
  onConfirm: () => void | Promise<void>;
}

export default function SettingsRemoveLocalZone({
  onConfirm,
}: SettingsRemoveLocalZoneProps) {
  const theme = useAppTheme();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const openConfirm = () => {
    if (removing) return; // 防双点：移除中不可再次打开
    setConfirmOpen(true);
  };

  const closeConfirm = () => {
    if (!removing) setConfirmOpen(false);
  };

  const handleConfirm = () => {
    if (removing) return;
    setConfirmOpen(false);
    setRemoving(true);
    void (async () => {
      try {
        await onConfirm();
      } finally {
        setRemoving(false);
      }
    })();
  };

  return (
    <View style={[styles.zone, { backgroundColor: theme.colorErrorBg }]}>
      <Text style={[styles.zoneTitle, { color: theme.colorError }]}>
        移除本机
      </Text>
      <Text style={[styles.zoneDescription, { color: theme.textSecondary }]}>
        解除与桌面端的配对，并清空本机的配对数据；移除后需重新配对。
      </Text>
      <Button
        label="移除本机"
        variant="danger"
        testID="settings-remove-local"
        loading={removing}
        disabled={removing}
        onPress={openConfirm}
        style={styles.zoneButton}
      />
      <Dialog
        visible={confirmOpen}
        title={REMOVE_LOCAL_DIALOG_TITLE}
        description={REMOVE_LOCAL_DIALOG_DESCRIPTION}
        testID="settings-remove-dialog"
        actions={removeLocalDialogActions(handleConfirm, closeConfirm)}
        onDismiss={closeConfirm}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  zone: {
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  zoneTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  zoneDescription: {
    fontSize: 13,
    lineHeight: 20,
  },
  zoneButton: {
    marginTop: 8,
  },
});
