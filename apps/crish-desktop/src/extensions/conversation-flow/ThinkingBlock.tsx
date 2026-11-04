/**
 * 思考块（叙事路径）：全文常驻 DOM（AN1 对齐折叠族配方）——折叠只收 grid
 * 行高、槽位挂 hidden="until-found"，头部行承载纯文本摘要（不再有独立的
 * 预览 markdown 解析）；展开/折叠与 ReasoningRow 同钟（根变量
 * --accordion-duration + calcAccordionDuration 自适应时长）。
 * live 呈现走 R13 完成门：只呈现已完成前缀（静态权威路径），未闭合的
 * 围栏 / `$$` / 表格 / HTML 整体扣留、零足迹——思考面不再经流式渲染
 * hook 的草稿结构合成（旧草稿收口器已随 R13 完成门落地删除）。
 * live 计时 ≤ 1Hz；查阅器仍走 thoughtInspector。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Button } from '@/components/ui';
import { clipThinkingPreview } from './narrativeModel';
import { MarkdownSurface } from '../../components/markdown/MarkdownSurface';
import { useMarkdownResult } from '../../api/markdown/useMarkdownRender';
import { splitDraftForPresentation } from '../../api/markdown/markdownCompletionGate';
import {
  calcAccordionDuration,
  accordionDurationStyle,
  DURATION_ACCORDION_MS,
} from '../../utils/motionTokens';
import { handleMarkdownEvent } from '../../components/markdown/markdownInteractions';
import { useI18n } from '../../i18n';
import styles from './narrative.module.css';

export interface ThinkingBlockProps {
  content: string;
  preview?: string;
  isLive?: boolean;
  durationMs?: number;
  messageId?: string;
  turnIndex?: number;
  defaultOpen?: boolean;
  onLinkClick?: (href: string) => void;
}

export function ThinkingBlock({
  content,
  preview,
  isLive = false,
  durationMs,
  defaultOpen = false,
  onLinkClick,
}: ThinkingBlockProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [liveSec, setLiveSec] = useState(0);
  const [accordionDuration, setAccordionDuration] = useState<number>(
    DURATION_ACCORDION_MS
  );
  const { t } = useI18n();
  const shownPreview = preview?.trim() || clipThinkingPreview(content);

  // R13 完成门：live 只呈现已完成前缀；非 live 全文即完成形态。
  const presentedContent = useMemo(
    () => (isLive ? splitDraftForPresentation(content).presentable : content),
    [isLive, content]
  );
  const fullResult = useMarkdownResult(presentedContent, 'chat', true);

  // 桥接（与 MarkdownBlockItem 同法）：前缀扩展后新静态结果未到达时，
  // 用上一份 HTML 顶住（其源是当前前缀的逐字前缀）；源分叉时不桥接。
  const bridgeRef = useRef<{ source: string; html: string }>({
    source: '',
    html: '',
  });
  useEffect(() => {
    if (fullResult.html) {
      bridgeRef.current = { source: presentedContent, html: fullResult.html };
    }
  }, [presentedContent, fullResult.html]);
  const bridge = bridgeRef.current;
  const fullHtml =
    fullResult.html ||
    (bridge.html && presentedContent.startsWith(bridge.source)
      ? bridge.html
      : '');

  useEffect(() => {
    if (!isLive) {
      setLiveSec(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(() => {
      setLiveSec(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [isLive]);

  const durationLabel =
    isLive && liveSec > 0
      ? `${liveSec}s`
      : durationMs != null && durationMs > 0
        ? `${(durationMs / 1000).toFixed(1)}s`
        : '';

  // ── 隐藏协调（与 ReasoningRow / FoldableProcessSection 同构）──
  // 全文常驻：展开摘除 hidden；折叠 transitionend 为主触发、同钟定时器
  // 兜底——兜底定时器只补 hidden 属性，永不卸载 DOM；beforematch 命中
  // 隐藏内容时自动展开。
  const gridRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const setSlotRef = useCallback((node: HTMLDivElement | null) => {
    slotRef.current = node;
    if (!node) return;
    if (openRef.current) node.removeAttribute('hidden');
    else node.setAttribute('hidden', 'until-found');
  }, []);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return undefined;
    if (open) {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      slot.removeAttribute('hidden');
      return undefined;
    }
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      if (!openRef.current) {
        slotRef.current?.setAttribute('hidden', 'until-found');
      }
    }, accordionDuration);
    return () => {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    };
  }, [open, accordionDuration]);

  const handleGridTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.target !== gridRef.current) return;
      if (event.propertyName !== 'grid-template-rows') return;
      if (openRef.current) return;
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      slotRef.current?.setAttribute('hidden', 'until-found');
    },
    []
  );

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return undefined;
    const handleBeforeMatch = () => {
      setAccordionDuration(calcAccordionDuration(400, true));
      setOpen(true);
    };
    slot.addEventListener('beforematch', handleBeforeMatch);
    return () => {
      slot.removeEventListener('beforematch', handleBeforeMatch);
    };
  }, []);

  const handleToggle = useCallback(() => {
    // 注：本目录源码锁禁测高类 API（叙事面零测高），开合时长均走家族
    // 估计口径（400px 估计，与 ReasoningRow 展开估计同源）。
    setAccordionDuration(
      open
        ? calcAccordionDuration(400, false)
        : calcAccordionDuration(400, true)
    );
    setOpen(!open);
  }, [open]);

  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;

      if (onLinkClick) {
        const anchor = target.closest('a');
        if (anchor instanceof HTMLAnchorElement) {
          const href = anchor.getAttribute('href');
          if (href) {
            e.preventDefault();
            e.stopPropagation();
            onLinkClick(href);
            return;
          }
        }
      }
      handleMarkdownEvent(e, { t });
    },
    [onLinkClick, t]
  );

  return (
    <div
      className={styles.thinking}
      data-flow-thinking=""
      data-live={isLive ? 'true' : undefined}
      data-flow-expanded={open ? 'true' : 'false'}
      style={accordionDurationStyle(accordionDuration)}
    >
      <div className={styles.actionHeadRow}>
        <Button
          variant="ghost"
          type="button"
          className={styles.head}
          aria-expanded={open}
          onClick={handleToggle}
        >
          {isLive ? <span className={styles.pulse} aria-hidden /> : null}
          <span className={styles.primary}>
            {isLive ? '正在思考' : '思考过程'}
          </span>
          {durationLabel ? (
            <span className={styles.meta}>{durationLabel}</span>
          ) : null}
          {/* 头部摘要（AN1 降级形态）：纯文本截断，不再单独解析预览 markdown */}
          {!open && shownPreview ? (
            <span
              className={styles.thinkingSummary}
              data-flow-thinking-preview=""
            >
              {shownPreview}
            </span>
          ) : null}
        </Button>
      </div>
      <div
        ref={gridRef}
        className={styles.thinkingGrid}
        onTransitionEnd={handleGridTransitionEnd}
      >
        <div ref={setSlotRef} className={styles.thinkingSlot}>
          <MarkdownSurface
            className={styles.thinkingFull}
            variant="chat"
            isActive={false}
            html={fullHtml}
            onClick={handleContentClick}
            dataAttributes={{ 'data-flow-thinking-full': '' }}
          />
        </div>
      </div>
    </div>
  );
}
