/**
 * 应用更新状态（RUN-03/GAP-01：真实 updater 链路）。
 *
 * - `checkForUpdate`：调用后端 `workbench_check_update`（经 tauri-plugin-updater
 *   拉取通道 latest.json 比对版本），检查返回值是 `setUpdateAvailable` 的唯一
 *   真实写入点（available=true 置标记 / false 清除标记，二者均广播
 *   `crish-update-changed` 供 Sidebar 同步角标）；
 * - `applyUpdateWhenIdle`：无阻塞任务时调用后端 `workbench_apply_update`
 *   （检查→下载→Minisign 验签→安装→重启一次编排）。任一步失败即返回
 *   `{ok:false}` 与可见错误，**严禁**吞错后误报成功（R-21/R-15）。
 */

import { listBackgroundTasks } from './backgroundTasksApi';
import { t } from '../i18n';

const KEY = 'crish_update_available';

export function isUpdateAvailable(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 更新标记唯一写入点：仅在「检查更新命令返回值」驱动下调用
 * （available=true 写入 / false 清除），广播事件同步 Sidebar 角标。
 */
function setUpdateAvailable(v: boolean): void {
  try {
    if (v) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* swallow-ok: 更新标记尽力写，quota/隐私模式失败仅影响本次会话提示 */
  }
  try {
    window.dispatchEvent(
      new CustomEvent('crish-update-changed', { detail: { available: v } })
    );
  } catch {
    /* swallow-ok: 更新事件分发失败不影响已改标记 */
  }
}

/** 是否有运行中任务（流/后台）— 有则不宜立刻装更新 */
async function hasBlockingTasks(): Promise<boolean> {
  try {
    const tasks = await listBackgroundTasks();
    if (
      Array.isArray(tasks) &&
      tasks.some((t) => {
        const s = String((t as { state?: string }).state || '').toLowerCase();
        return s === 'running' || s === 'pending' || s === 'active';
      })
    ) {
      return true;
    }
  } catch {
    /* swallow-ok: 后台任务探测失败按无阻塞处理，更新放行 */
  }
  return false;
}

interface CheckUpdateResult {
  /** 后端结构化状态（RUN-03：前端按 status 分支，严禁对文案做字符串匹配） */
  status?: 'available' | 'upToDate';
  available?: boolean;
  currentVersion?: string;
  version?: string;
}

/** 检查更新的结构化结果（文案由 t() 生成，判定走 outcome，禁止字符串匹配） */
export type CheckUpdateOutcome = 'available' | 'upToDate' | 'failed';

/**
 * 检查更新：调用后端真实检查命令，按返回值写入/清除更新标记。
 * 返回结构化结果：`outcome` 供 UI 分支，`message` 为已本地化兜底文案。
 */
export async function checkForUpdate(): Promise<{
  outcome: CheckUpdateOutcome;
  version?: string;
  message: string;
}> {
  try {
    const { invokeResult } = await import('./tauriInvoke');
    const res = await invokeResult<CheckUpdateResult>('workbench_check_update');
    if (res.status === 'error') {
      return {
        outcome: 'failed',
        message: res.message || t('about.updateFailed', '检查更新失败'),
      };
    }
    if (res.status !== 'ok' || !res.data) {
      return {
        outcome: 'failed',
        message: t('about.updateFailed', '检查更新失败'),
      };
    }
    if (res.data.status === 'available') {
      const version = res.data.version;
      setUpdateAvailable(true);
      return {
        outcome: 'available',
        version,
        message: t('about.newVersionAvailable', '发现新版本：{version}', {
          version: version ?? '',
        }),
      };
    }
    if (res.data.status === 'upToDate') {
      // 显式无更新：清除陈旧标记（真实写入点，upToDate 分支）
      setUpdateAvailable(false);
      return {
        outcome: 'upToDate',
        message: t('about.upToDate', '已是最新版本'),
      };
    }
    // 未知状态：如实按失败处理，严禁臆判「无更新」或「有更新」
    return {
      outcome: 'failed',
      message: t('about.updateFailed', '检查更新失败'),
    };
  } catch (err) {
    // 非 Tauri 环境 / invoke 异常：如实报失败，不误报
    return {
      outcome: 'failed',
      message: t('about.checkUpdateFailedDetail', '检查更新失败：{error}', {
        error: String(err),
      }),
    };
  }
}

/**
 * 安装更新：无阻塞任务时调用后端一次编排（下载验签安装重启）。
 * 失败路径（断网/签名不符/磁盘满）原样透出可见错误，不误报成功。
 * 成功时进程随安装/重启退出，本应答通常不会被消费（toast 仅兜底展示）。
 */
export async function applyUpdateWhenIdle(): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!isUpdateAvailable()) {
    return {
      ok: false,
      message: t('about.noUpdateAvailable', '当前没有可用更新'),
    };
  }
  if (await hasBlockingTasks()) {
    return {
      ok: false,
      message: t(
        'about.tasksRunningBlockUpdate',
        '仍有任务在运行，请结束后再更新'
      ),
    };
  }
  try {
    const { invokeResult } = await import('./tauriInvoke');
    const res = await invokeResult<{
      ok?: boolean;
      status?: string;
      available?: boolean;
    }>('workbench_apply_update');
    if (res.status === 'error') {
      // 后端检查/下载/验签/安装任一步失败：错误原样可见
      return {
        ok: false,
        message: res.message || t('about.applyUpdateFailed', '更新失败'),
      };
    }
    if (res.status !== 'ok') {
      return {
        ok: false,
        message: t('about.updateChannelUnavailable', '更新通道不可用'),
      };
    }
    if (res.data?.status === 'noUpdate' || res.data?.available === false) {
      // 通道已无新版本（标记陈旧）：清除并如实提示
      setUpdateAvailable(false);
      return {
        ok: false,
        message: t('about.noUpdateAvailable', '当前没有可用更新'),
      };
    }
  } catch (err) {
    // invoke 异常：如实报失败，严禁吞错后清标记假成功
    return {
      ok: false,
      message: t('about.applyUpdateFailedDetail', '更新失败：{error}', {
        error: String(err),
      }),
    };
  }
  // 后端 install 后即重启（Windows 安装器 / macOS·Linux restart），到不了这里；
  // 若极端情况下未重启，如实提示已安装待重启。
  setUpdateAvailable(false);
  return {
    ok: true,
    message: t(
      'about.updateInstalledRestart',
      '更新包已安装，请重启应用完成更新'
    ),
  };
}
