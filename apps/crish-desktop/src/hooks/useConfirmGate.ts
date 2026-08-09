/**
 * useConfirmGate —— window.confirm 的 Promise 桥（04-detail §2.1.1，03-detail T15）
 *
 * 消费侧统一「Promise 桥」形态，供批次 4.1 的 9 文件 window.confirm 替换消费：
 *
 *   const [confirmGate, renderConfirmGate] = useConfirmGate();
 *   // 调用点：
 *   if (!(await confirmGate({ title, description, confirmLabel, danger }))) return;
 *   // 渲染点（宿主组件根部）：
 *   {renderConfirmGate(<ConfirmDialog />)}
 *
 * 契约：
 * - confirmGate 返回 Promise<boolean>：确认 → true；取消·Esc·遮罩 → false。
 *   挂起式调用语义 = window.confirm 的异步等价；
 * - 桥与 ui/ConfirmDialog 解耦：基座只承诺确定回调语义（onConfirm/onCancel），
 *   桥负责 Promise 化——消费点只接触 confirmGate，不接触基座细节；
 * - 并发调用语义：**后调覆盖前调**（前调按「取消」结算，防旧调用点悬挂）——
 *   当前 04 消费面无并发场景，此语义仅作兜底登记（03-detail T15 测试清单第 2 条）；
 * - 卸载保护：组件卸载时挂起中的调用以「取消」结算（resolve(false)），不泄漏；
 * - 渲染点渲染物为单例：同一时刻最多一个 pending，重复调用 renderConfirmGate
 *   不重复挂载 ConfirmDialog。
 *
 * 分层契约：hooks/ 业务层依赖 ui/ 原子层（类型 import），反向不成立。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmDialogProps } from '../components/ui';

/** confirmGate 请求载荷：与 ui/ConfirmDialog 的展示 props 对齐（渲染点元素 props 优先覆盖） */
export interface ConfirmGateRequest {
  title?: ConfirmDialogProps['title'];
  description?: ConfirmDialogProps['description'];
  confirmLabel?: ConfirmDialogProps['confirmLabel'];
  cancelLabel?: ConfirmDialogProps['cancelLabel'];
  danger?: ConfirmDialogProps['danger'];
  disabled?: ConfirmDialogProps['disabled'];
  size?: ConfirmDialogProps['size'];
}

export type ConfirmGate = (request: ConfirmGateRequest) => Promise<boolean>;
export type ConfirmGateRender = (
  view: React.ReactElement<ConfirmDialogProps>
) => React.ReactElement | null;

interface PendingGate {
  request: ConfirmGateRequest;
  resolve: (ok: boolean) => void;
}

export function useConfirmGate(): [ConfirmGate, ConfirmGateRender] {
  const [pending, setPending] = useState<PendingGate | null>(null);
  // ref 镜像：settle 与卸载清理不依赖渲染闭包，避免 setState 时序竞态
  const pendingRef = useRef<PendingGate | null>(null);
  // 挂起期间渲染物单例缓存：同一 pending 重复调用 renderConfirmGate 不重复挂载
  const viewCacheRef = useRef<React.ReactElement<ConfirmDialogProps> | null>(null);

  const settle = useCallback((ok: boolean) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    viewCacheRef.current = null;
    setPending(null);
    p?.resolve(ok);
  }, []);

  const confirmGate = useCallback((request: ConfirmGateRequest) => {
    // 后调覆盖前调：前调按「取消」结算（安全回落，调用点不会悬挂）
    const prev = pendingRef.current;
    pendingRef.current = null;
    viewCacheRef.current = null;
    setPending(null);
    prev?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const p: PendingGate = { request, resolve };
      pendingRef.current = p;
      setPending(p);
    });
  }, []);

  // 卸载保护：挂起中的调用不 resolve 泄漏 → 以「取消」结算
  useEffect(() => {
    return () => {
      const p = pendingRef.current;
      pendingRef.current = null;
      viewCacheRef.current = null;
      p?.resolve(false);
    };
  }, []);

  const renderConfirmGate = useCallback<ConfirmGateRender>(
    (view) => {
      if (!pending) return null;
      // 单例：同一 pending 期间首次调用生成渲染物，重复调用返回 null（不重复挂载）
      if (viewCacheRef.current) return null;
      const { request } = pending;
      viewCacheRef.current = React.cloneElement(view, {
        open: true,
        title: view.props.title ?? request.title,
        description: view.props.description ?? request.description,
        confirmLabel: view.props.confirmLabel ?? request.confirmLabel,
        cancelLabel: view.props.cancelLabel ?? request.cancelLabel,
        danger: view.props.danger ?? request.danger,
        disabled: view.props.disabled ?? request.disabled,
        size: view.props.size ?? request.size,
        onConfirm: () => settle(true),
        onCancel: () => settle(false),
      });
      return viewCacheRef.current;
    },
    [pending, settle]
  );

  return [confirmGate, renderConfirmGate];
}
