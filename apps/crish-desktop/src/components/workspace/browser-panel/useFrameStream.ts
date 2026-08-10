/**
 * 帧流 hook（P1-B1）：Tauri Channel 订阅 → 帧解码（定长头 + JPEG）→
 * canvas 绘制（尺寸自适应 / DPR / contain 等比）。
 *
 * 对齐 12 文档：
 * - §2.3 渲染循环：解码（createImageBitmap）与绘制分离，每 rAF 只消费 1 帧，
 *   解码慢不阻塞 rAF；pending 队列深 1（新帧替换未渲染旧帧 = 丢帧策略，
 *   §2.4——画面永远追最新，不追赶不重传）；
 * - DPR 自适应：canvas 物理像素 = CSS 尺寸 × devicePixelRatio，
 *   `setTransform(dpr, ...)` 后按 CSS 坐标绘制；坐标捕获侧同理
 *   （InputLayer 用 getBoundingClientRect CSS 坐标，DPR 自然抵消）；
 * - 无帧时由 FrameCanvas 显示「帧流未激活」占位（本 hook 只维护状态）。
 *
 * 生命周期：`active=true`（面板 running）→ browser_start_frames 注册通道；
 * `active=false` / 卸载 → browser_stop_frames（幂等）+ 通道释放（JS 端
 * Channel 释放后引擎收到 end 事件，退订即停流，省资源）。
 *
 * 降级策略（非 Tauri / 测试环境）：Channel 不可用（test-setup mock 无导出）
 * 或命令 missing → 静默停流（frameState 保持 stopped，不 toast——帧流为
 * 增强面，面板主体功能不受影响）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startBrowserFrames,
  stopBrowserFrames,
} from '../../../api/browserSessionApi';
import {
  framePayloadToBlob,
  parseFrameMessage,
  type ParsedFrame,
} from './frameProtocol';
import { containFit } from './inputNormalize';
import type { BrowserFrameMeta, BrowserFrameState } from './browserPanelTypes';

/** 测试注入面：Channel 构造工厂（默认惰性取 @tauri-apps/api/core；非 Tauri 返回 null）。 */
export type FrameChannelFactory = () => {
  onmessage: ((message: ArrayBuffer) => void) | null;
} | null;

async function defaultChannelFactory(): Promise<
  { onmessage: ((message: ArrayBuffer) => void) | null } | null
> {
  try {
    const mod = await import('@tauri-apps/api/core');
    if (typeof mod?.Channel !== 'function') return null;
    return new mod.Channel<ArrayBuffer>();
  } catch {
    return null;
  }
}

export interface UseFrameStreamOptions {
  /** 面板 running 态时订阅帧流；退出时退订。 */
  active: boolean;
  /** 测试注入 Channel 工厂；缺省惰性加载 @tauri-apps/api/core（非 Tauri 降级）。 */
  channelFactory?: () => Promise<
    { onmessage: ((message: ArrayBuffer) => void) | null } | null
  >;
}

export interface UseFrameStreamResult {
  /** 帧流状态（引擎契约：starting/active/stopped）。 */
  frameState: BrowserFrameState;
  /** 最近渲染帧元信息（坐标映射 / 丢帧诊断；无帧 = null）。 */
  lastFrame: BrowserFrameMeta | null;
  /** 绘制目标 canvas（FrameCanvas 挂载）。 */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

/** 渲染队列深 1（丢帧策略 §2.4）：解码中的帧被新帧替换即丢弃。 */
interface PendingFrame {
  meta: BrowserFrameMeta;
  blob: Blob;
}

export function useFrameStream(
  opts: UseFrameStreamOptions,
): UseFrameStreamResult {
  const { active, channelFactory } = opts;
  const [frameState, setFrameState] = useState<BrowserFrameState>('stopped');
  const [lastFrame, setLastFrame] = useState<BrowserFrameMeta | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // 渲染循环状态（ref 面，避免 rAF 闭包陈旧）
  const pendingRef = useRef<PendingFrame | null>(null);
  const renderingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const lastRenderedSeqRef = useRef(-1);

  // 通道引用（卸载时释放）+ 工厂缓存
  const channelRef = useRef<{
    onmessage: ((message: ArrayBuffer) => void) | null;
  } | null>(null);
  const factoryRef = useRef(channelFactory);
  factoryRef.current = channelFactory;
  const activeRef = useRef(active);
  activeRef.current = active;

  /** 绘制一帧（§2.3）：DPR 自适应 + contain 等比 + createImageBitmap 异步解码。 */
  const drawFrame = useCallback(async (pending: PendingFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) return; // 画布未挂载：本帧丢弃（下帧自然重试）
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return; // jsdom/不可用环境：仅消费状态，不绘制

    const { meta, blob } = pending;
    let bitmap: ImageBitmap | null = null;
    // 解码在 rAF 外（createImageBitmap 异步，不阻塞主线程）
    if (typeof createImageBitmap === 'function') {
      try {
        bitmap = await createImageBitmap(blob);
      } catch {
        bitmap = null;
      }
    }
    // 解码期间画布/激活态变化 → 丢弃（防陈旧帧落地）
    if (!activeRef.current) {
      bitmap?.close?.();
      return;
    }
    if (!ctx.canvas.isConnected) {
      bitmap?.close?.();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 0;
    const cssH = canvas.clientHeight || 0;
    if (cssW > 0 && cssH > 0) {
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cssW, cssH);
      if (bitmap) {
        // contain 等比填满（§2.3 object-fit: contain 同语义；与 InputLayer
        // 坐标映射共用同一 containFit，保证点对点一致）
        const fit = containFit(cssW, cssH, meta.width, meta.height);
        ctx.drawImage(
          bitmap,
          fit.offsetX,
          fit.offsetY,
          fit.displayWidth,
          fit.displayHeight,
        );
      }
    }
    bitmap?.close?.();
    lastRenderedSeqRef.current = meta.seq;
  }, []);

  /** rAF 循环：每帧只消费 1 帧；积压则继续（仍是最新优先）。 */
  const scheduleDraw = useCallback(() => {
    if (renderingRef.current) return;
    renderingRef.current = true;
    rafRef.current = requestAnimationFrame(async () => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) {
        await drawFrame(pending);
      }
      renderingRef.current = false;
      if (pendingRef.current) scheduleDraw();
    });
  }, [drawFrame]);

  /** 通道消息 → 解析 → 入队（深 1）+ 状态 active。 */
  const onChannelMessage = useCallback(
    (message: ArrayBuffer) => {
      const parsed: ParsedFrame | null = parseFrameMessage(message);
      if (!parsed) return; // 非法/空帧：防御忽略
      const meta: BrowserFrameMeta = {
        seq: parsed.seq,
        width: parsed.width,
        height: parsed.height,
      };
      setLastFrame(meta);
      setFrameState('active');
      pendingRef.current = { meta, blob: framePayloadToBlob(parsed.payload) };
      scheduleDraw();
    },
    [scheduleDraw],
  );

  // 订阅生命周期：active 翻转 / 卸载
  useEffect(() => {
    if (!active) {
      // 退订（幂等；引擎侧停止帧泵）
      stopBrowserFrames().catch(() => {
        /* missing/error：静默降级 */
      });
      setFrameState('stopped');
      return;
    }
    let cancelled = false;
    let createdChannel: { onmessage: ((message: ArrayBuffer) => void) | null } | null =
      null;
    const factory = factoryRef.current || defaultChannelFactory;

    (async () => {
      const channel = await factory();
      if (cancelled) return;
      if (!channel) {
        // 非 Tauri / Channel 不可用：保持 stopped（降级路径）
        return;
      }
      createdChannel = channel;
      channelRef.current = channel;
      channel.onmessage = (message: ArrayBuffer) => {
        if (!activeRef.current) return;
        onChannelMessage(message);
      };
      setFrameState('starting');
      const res = await startBrowserFrames(channel as never);
      if (cancelled) return;
      if (res.status === 'ok') {
        setFrameState(res.data?.state ?? 'starting');
      } else {
        // missing/error：帧流不可用 → 停流静默（面板主体不受影响）
        setFrameState('stopped');
        channelRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
      if (createdChannel) {
        // 通道释放（JS 端触发 end → 引擎退订即停流）
        createdChannel.onmessage = null;
      }
      channelRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = null;
      setFrameState('stopped');
      stopBrowserFrames().catch(() => {
        /* 静默降级 */
      });
    };
  }, [active, onChannelMessage]);

  return { frameState, lastFrame, canvasRef };
}
