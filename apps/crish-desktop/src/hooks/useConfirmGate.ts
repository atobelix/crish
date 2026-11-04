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
 * - 并发调用语义：**FIFO 队列**（2026-11-03 批 C 第 3 件改判，取代原
 *   「后调覆盖前调」）：多个调用依次排队呈现，无静默消失；每个调用方
 *   的 Promise 只由其对应条目的决定落定——先者被取消不影响排队者，
 *   排队者也不会被先者的决定连带结算。原覆盖语义下先者的对话框永不
 *   出现且其调用方按「取消」继续（FN-4），对「确认后才执行」的非危险
 *   流程等于静默跳过确认，故废弃；
 * - 卸载保护：组件卸载时当前条目与全部排队条目一并以「取消」结算
 *   （resolve(false)），不泄漏；
 * - 渲染点渲染物为单例：同一时刻最多呈现一个条目（队列头），重复调用
 *   renderConfirmGate 不重复挂载 ConfirmDialog。
 *
 * 分层契约：hooks/ 业务层依赖 ui/ 原子层（类型 import），反向不成立。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmDialogProps } from '@/components/ui';

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
  const [current, setCurrent] = useState<PendingGate | null>(null);
  // ref 镜像：当前条目与等待队列不依赖渲染闭包，避免 setState 时序竞态
  const currentRef = useRef<PendingGate | null>(null);
  const queueRef = useRef<PendingGate[]>([]);
  // 呈现期间渲染物单例缓存：同一条目重复调用 renderConfirmGate 不重复挂载
  const viewCacheRef = useRef<React.ReactElement<ConfirmDialogProps> | null>(
    null
  );

  // 队列头推进：当前条目结算/卸载后调用；无排队者则回到空闲
  const promote = useCallback(() => {
    const next = queueRef.current.shift() ?? null;
    currentRef.current = next;
    viewCacheRef.current = null;
    setCurrent(next);
  }, []);

  const settle = useCallback(
    (ok: boolean) => {
      const p = currentRef.current;
      if (!p) return;
      // 先推进队列再 resolve 本条目：resolve 的同步重入（调用方紧接着
      // 再次 confirmGate）看到的是已推进的状态，不会踩到旧条目
      promote();
      p.resolve(ok);
    },
    [promote]
  );

  const confirmGate = useCallback((request: ConfirmGateRequest) => {
    return new Promise<boolean>((resolve) => {
      const entry: PendingGate = { request, resolve };
      if (currentRef.current) {
        // FIFO：已有呈现中的条目 → 排队等待，绝不覆盖（FN-4）
        queueRef.current.push(entry);
      } else {
        currentRef.current = entry;
        viewCacheRef.current = null;
        setCurrent(entry);
      }
    });
  }, []);

  // 卸载保护：当前 + 全部排队条目以「取消」结算，不 resolve 泄漏
  useEffect(() => {
    return () => {
      const p = currentRef.current;
      currentRef.current = null;
      const queued = queueRef.current;
      queueRef.current = [];
      viewCacheRef.current = null;
      p?.resolve(false);
      for (const entry of queued) entry.resolve(false);
    };
  }, []);

  const renderConfirmGate = useCallback<ConfirmGateRender>(
    (view) => {
      if (!current) return null;
      // 单例：同一条目呈现期间首次调用生成渲染物，重复调用返回 null（不重复挂载）
      if (viewCacheRef.current) return null;
      const { request } = current;
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
    [current, settle]
  );

  return [confirmGate, renderConfirmGate];
}
