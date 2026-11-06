// 流式文本呈现节拍 hook（波 6 达标步收敛：单一平准路径）
// - 唯一时钟：AdaptiveStreamingSmoother 的浮点游标同时决定「揭示什么、何时
//   揭示」与每个字素的 birthTime（时间渐显与节奏共用同一游标，无第二套节拍）；
// - 生产默认即平准路径，不存在模式开关：到达的全文先入缓冲池，按人体阅读
//   速度（基线 32 字/秒、封顶 70 字/秒，惯性加减速）匀速揭示，网络抖动被
//   吸收为速度变化而非整段跳变；
// - 挂载 / 条目切换先种子化：已在屏上的全文视为已揭示（不重打），仅末尾
//   渐显窗口带合成出生时刻，其后新增文本才进入平准揭示；
// - 终态（streaming=false）：平准器进入泄洪（100–280ms）收敛至 100% 全文，
//   泄洪期调用方以「呈现文本 ≠ 目标全文」识别追赶态、维持流式分治与渐显；
// - 卸载清理：组件退场即重置平准器（清 rAF 与状态），无残留回调。
import { useEffect, useRef, useState } from 'react';
import type { TailFadeFrame } from '@/domain/pure/markdown/temporalFade';
import {
  AdaptiveStreamingSmoother,
  type SmootherOptions,
} from './AdaptiveStreamingSmoother';

/** 呈现帧：渲染文本与尾部渐显帧同源同钟（同一次平准提交产出） */
export interface StreamingTextFrame {
  /** 当前应渲染的文本（平准游标已揭示部分，恒为目标全文的前缀） */
  text: string;
  /** 尾部时间渐显帧：出生登记 + 本帧时刻（与 birthTime 同时钟） */
  tailFade: TailFadeFrame;
}

/** 平准参数（速度档位 / 提交节流 / 时钟注入）；构造期生效，运行中变更不追溯 */
export type UseStreamingTextOptions = SmootherOptions;

function snapshotFrame(
  smoother: AdaptiveStreamingSmoother
): StreamingTextFrame {
  const snap = smoother.getSnapshot();
  return {
    text: snap.text,
    tailFade: { births: snap.tailBirths, atTime: snap.atTime },
  };
}

/**
 * 流式文本呈现 Hook：
 * @param identity 条目稳定键（同 seq 覆盖保持不变；变化 = 新条目，立即种子化）
 * @param latestText 数据面最新全文（preview 帧覆盖式）
 * @param streaming 流式期标记（false = 终态已到：泄洪收敛至全文）
 * @param options 平准参数
 * @returns 呈现帧（渲染文本 + 尾部渐显帧）
 */
export function useStreamingText(
  identity: string,
  latestText: string,
  streaming: boolean,
  options: UseStreamingTextOptions = {}
): StreamingTextFrame {
  // 平准器单例（渲染期惰性构造，与本文件旧实现同款纪律；构造参数首帧生效）
  const smootherRef = useRef<AdaptiveStreamingSmoother | null>(null);
  if (smootherRef.current === null) {
    const smoother = new AdaptiveStreamingSmoother(() => {
      setFrame(snapshotFrame(smoother));
    }, options);
    smoother.seed(latestText, streaming);
    smootherRef.current = smoother;
  }
  const smoother = smootherRef.current;

  const [frame, setFrame] = useState<StreamingTextFrame>(() =>
    snapshotFrame(smoother)
  );
  const [prevIdentity, setPrevIdentity] = useState(identity);
  const seededIdentityRef = useRef(identity);

  // 数据面推入：挂载首帧已在构造期种子化；条目切换已在渲染期种子化，
  // effect 只需同步条目键，其余情形把最新全文推给平准器
  useEffect(() => {
    if (seededIdentityRef.current !== identity) {
      seededIdentityRef.current = identity;
      return;
    }
    smoother.updateTarget(latestText, streaming);
  }, [smoother, identity, latestText, streaming]);

  // 卸载清理：退订平准器（清 rAF），无残留回调
  useEffect(() => {
    return () => {
      smoother.reset();
    };
  }, [smoother]);

  // 新条目（键变化）：立即种子化新全文（不闪烁、不重打），旧状态全清
  if (identity !== prevIdentity) {
    setPrevIdentity(identity);
    smoother.reset();
    smoother.seed(latestText, streaming);
    const snap = snapshotFrame(smoother);
    setFrame(snap);
    return snap;
  }

  return frame;
}
