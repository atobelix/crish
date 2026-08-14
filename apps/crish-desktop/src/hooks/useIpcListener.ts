/**
 * useIpcListener Hook — 统一封装 Tauri IPC 客户端事件监听生命周期。
 *
 * 核心保证：
 * 1. 自动使用 useRef 捕获最新 handler，避免闭包陈旧，同时防止 handler 引用抖动触发 listener 反复卸载/重挂载；
 * 2. 异步生命周期对称性：安全处理 listen().then(unlisten) 与组件快速卸载/React 18 StrictMode 双挂载竞态；
 *    - 若组件在 listen() 完成前已卸载（disposed = true），则在 Promise resolve 时立即调用 unlisten() 进行销毁；
 *    - 若组件正常卸载，清理函数调用已持有的 unlistenFn()；
 * 3. 错误安全：捕获监听注册异常，防止非 Tauri 或测试环境下的 Unhandled Promise Rejection。
 */
import { useEffect, useRef } from 'react';
import {
  listen,
  type UnlistenFn,
  type EventCallback,
  type Event,
  type Options,
} from '@tauri-apps/api/event';

export interface UseIpcListenerOptions extends Options {
  /** 是否启用监听（默认为 true） */
  enabled?: boolean;
}

export function useIpcListener<T = unknown>(
  eventName: string,
  handler: EventCallback<T>,
  options?: UseIpcListenerOptions
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const enabled = options?.enabled ?? true;
  const target = options?.target;

  useEffect(() => {
    if (!enabled || !eventName) return;

    let unlistenFn: UnlistenFn | null = null;
    let disposed = false;

    const promise = listen<T>(
      eventName,
      (event: Event<T>) => {
        if (!disposed) {
          handlerRef.current(event);
        }
      },
      target ? { target } : undefined
    );

    promise
      .then((unlisten) => {
        if (disposed) {
          try {
            unlisten();
          } catch {
            // 忽略组件已卸载时的清理容错
          }
        } else {
          unlistenFn = unlisten;
        }
      })
      .catch((err) => {
        if (!disposed) {
          console.warn(
            `[useIpcListener] listen("${eventName}") 注册失败:`,
            err
          );
        }
      });

    return () => {
      disposed = true;
      if (unlistenFn) {
        try {
          unlistenFn();
        } catch {
          // 忽略清理容错
        }
        unlistenFn = null;
      }
    };
  }, [eventName, enabled, target]);
}

export type { Event, EventCallback, UnlistenFn };
