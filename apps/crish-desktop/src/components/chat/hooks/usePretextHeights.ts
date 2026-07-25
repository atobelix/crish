import { useEffect, useMemo, useRef, useState } from 'react';
import { buildPretextFontForUiSize } from '../../utils/pretextFontBridge';
import { MESSAGE_ESTIMATED_ROW_HEIGHT } from '../../api/messageWindow';
import { getWorkerPool, Priority } from '../../workers/index';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import type { SessionMessage } from '../../store/layoutStore';

const TEXT_LINE_HEIGHT = 22;

export function usePretextHeights(
  enableVirtualization: boolean,
  visibleMessages: SessionMessage[],
  containerRef: React.RefObject<HTMLDivElement | null>,
  manager: VirtualScrollManager,
) {
  const pretextFont = useMemo(() => {
    try { return buildPretextFontForUiSize('medium', 'sans', 'normal'); } catch { return null; }
  }, []);

  const [containerWidth, setContainerWidth] = useState(680);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const abortRef = useRef<AbortController | null>(null);

  const messagesVersion = visibleMessages
    .map(m => `${m.id}:${m.text ?? ''}:${m.toolCalls?.length ?? 0}`)
    .join('|');

  useEffect(() => {
    if (!enableVirtualization || !pretextFont || containerWidth <= 0) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const availWidth = Math.max(1, containerWidth - 32);
    const pending = visibleMessages
      .map((msg, i) => ({ msg, i }))
      .filter(({ msg, i }) => msg != null && manager.getHeight(i) === MESSAGE_ESTIMATED_ROW_HEIGHT);
    if (pending.length === 0) return;

    const items = pending.map(({ msg, i }) => ({
      index: i,
      text: msg!.text || '',
      toolCallCount: msg!.toolCalls?.length ?? 0,
    }));

    getWorkerPool().schedule<Array<{ index: number; height: number }>>(
      'compute',
      'pretext.batch-layout',
      { messages: items, font: pretextFont, availWidth, lineHeight: TEXT_LINE_HEIGHT },
      Priority.Low,
    ).then((results) => {
      if (ac.signal.aborted) return;
      for (const { index, height } of results) {
        if (manager.getHeight(index) === MESSAGE_ESTIMATED_ROW_HEIGHT) {
          manager.setEstimated(index, height);
        }
      }
    }).catch(() => {});

    return () => { ac.abort(); };
  }, [enableVirtualization, messagesVersion, pretextFont, containerWidth, manager]);

  return { pretextFont, containerWidth };
}
