import { router } from 'expo-router';
import { SettingsScreenView } from '@/presentation/components/settings';
import { useSettingsVm } from '@/adapters/viewmodels/useSettingsVm';

// 设置（R2-06 部分 3 落地，F6 设置域）：分组列表（通用主题三选 / 通知偏好 /
// 文件缩略图 / 关于）+ 移除本机双保险（R2UX-06-06）：
// - 数据面：useSettingsVm（本机偏好 + 主题投影 + 关于 wire 镜像 + 移除本机）；
// - 移除本机：确认后 unpair（清 secure-store + 断开 + authStore 复位）→
//   重定向 /pair/welcome（显式 router.replace；pairState 归位后 (tabs) 守卫
//   同样会重定向，双保险不冲突）；
// - 设置命令接线：settingsCommands（R2-11 B5）经 settingsRepository 命令面发送，
//   未连接时设置项「未连接」禁用态（任务书）。
export default function SettingsScreen() {
  const vm = useSettingsVm();

  const onConfirmRemove = () => {
    void vm.removeLocal().then((ok) => {
      if (ok) router.replace('/pair/welcome');
    });
  };

  return <SettingsScreenView vm={vm} onConfirmRemove={onConfirmRemove} />;
}
