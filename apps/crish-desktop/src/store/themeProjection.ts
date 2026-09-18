/**
 * themeProjection — settingsStore 主题订阅投影（D3 收敛段一，T-E 批次 5）。
 *
 * 真源 = `settingsStore.appSettings.theme`（收敛后）。订阅投影职责：
 * - 监听 appSettings.theme 变化 → `setTheme`（DOM 应用 + 偏好持久化 +
 *   crish-theme-changed 事件，themeStore 的写端入口函数）
 *   单一写端即本投影（persistTheme 生产调用点收敛为 1 处）。
 * - 启动播种（AppBootstrap 原 :238-244 的 applyTheme + persistTheme 双写）
 *   抽为本投影的首次执行。
 *
 * 两段式：段二 = 04 批次 1 断链命令修复后，「saveSettingsEx → 引擎命令 →
 * 事件回灌 settingsStore」链路自动完整（回灌同样经 setAppSettings → 本投影，
 * 设置页与回灌都经 settingsStore 单一写入口）。
 *
 * 幂等：同 theme 值重复触发跳过（avoid 无谓 DOM/缓存写）。
 */
import { useSettingsStore } from './settingsStore';
import { setTheme } from '../api/themeStore';

/**
 * 装配主题订阅投影；返回退订函数（AppBootstrap 启动调一次）。
 * 首次调用立即执行一次播种（appSettings 已就绪时）。
 */
export function initThemeProjection(): () => void {
  let prevTheme: string | undefined;
  let isApplying = false;

  const apply = () => {
    if (isApplying) return;
    const theme = useSettingsStore.getState().appSettings?.theme;
    if (theme === undefined || theme === null || theme === prevTheme) return;
    prevTheme = theme;
    isApplying = true;
    try {
      setTheme(theme);
    } finally {
      isApplying = false;
    }
  };

  apply();
  return useSettingsStore.subscribe(apply);
}
