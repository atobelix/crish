// 活动文案最短驻留（批 B ⑰ 附带口径 / Cherry 深比 04-1·5）：流式期
// 「正在执行 · X」「正在思考...」这类当前活动文案若随工具切换逐帧跳
// 变会读成闪烁——文案变更须在上一条文案至少驻留
// MIN_ACTIVITY_LABEL_RESIDENCY_MS 后才上屏（驻留期内只记最新值，到点
// 一次落位）。活动结束（active=false）立即落位终态文案：驻留只防活
// 动期闪变，绝不延迟结果呈现。审批计数等即时信息不经本钩——其呈现
// 面（ApprovalFloat）自有口径，不在此收编。
import { useEffect, useRef, useState } from 'react';

/** 当前活动文案最短驻留（ms；深比口径 ≥1200ms） */
export const MIN_ACTIVITY_LABEL_RESIDENCY_MS = 1200;

/**
 * 返回经最短驻留整形后的文案。
 * @param text 当前文案（随上游状态实时变化）
 * @param active 是否处于活动期（true 时启用驻留整形；false 时直通）
 * @param minMs 驻留时长（缺省正典 1200ms）
 */
export function useMinResidencyText(
  text: string,
  active: boolean,
  minMs: number = MIN_ACTIVITY_LABEL_RESIDENCY_MS
): string {
  const [shown, setShown] = useState(text);
  const shownRef = useRef(text);
  const lastChangeAtRef = useRef(Date.now());
  const latestRef = useRef(text);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  latestRef.current = text;

  useEffect(() => {
    const flush = (value: string) => {
      shownRef.current = value;
      lastChangeAtRef.current = Date.now();
      setShown(value);
    };
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!active) {
      // 终态直通：结果呈现不被驻留拖延
      if (shownRef.current !== text) flush(text);
      return;
    }
    if (shownRef.current === text) return;
    const elapsed = Date.now() - lastChangeAtRef.current;
    if (elapsed >= minMs) {
      flush(text);
      return;
    }
    // 驻留期内多次变更只记最新（latestRef），到点一次落位
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (latestRef.current !== shownRef.current) flush(latestRef.current);
    }, minMs - elapsed);
  }, [text, active, minMs]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  return shown;
}
