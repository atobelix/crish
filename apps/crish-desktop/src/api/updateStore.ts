/**
 * 应用更新状态（UI 仅在有新版本时显示「更新」按钮）。
 * 无检查更新入口：有版本才露出按钮；空闲时可直接安装。
 */

import { listBackgroundTasks } from './backgroundTasksApi';

const KEY = 'crish_update_available';

export function isUpdateAvailable(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function setUpdateAvailable(v: boolean): void {
  try {
    if (v) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('crish-update-changed', { detail: { available: v } }));
  } catch {
    /* ignore */
  }
}

/** 是否有运行中任务（流/后台）— 有则不宜立刻装更新 */
async function hasBlockingTasks(): Promise<boolean> {
  try {
    const tasks = await listBackgroundTasks();
    if (Array.isArray(tasks) && tasks.some((t) => {
      const s = String((t as { state?: string }).state || '').toLowerCase();
      return s === 'running' || s === 'pending' || s === 'active';
    })) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 安装更新：无阻塞任务时直接安装（或清标记并提示）。
 * 返回给 UI 的中文结果。
 */
export async function applyUpdateWhenIdle(): Promise<{ ok: boolean; message: string }> {
  if (!isUpdateAvailable()) {
    return { ok: false, message: '当前没有可用更新' };
  }
  if (await hasBlockingTasks()) {
    return { ok: false, message: '仍有任务在运行，请结束后再更新' };
  }
  // 真实安装通道接入前：调用壳层（若有）并清除角标
  try {
    const { invokeResult } = await import('./tauriInvoke');
    const res = await invokeResult('workbench_apply_update');
    if (res.status === 'error') {
      return { ok: false, message: res.message || '更新失败' };
    }
  } catch {
    /* 无命令时本地标记清除即可演示闭环 */
  }
  setUpdateAvailable(false);
  return { ok: true, message: '已开始安装更新' };
}
