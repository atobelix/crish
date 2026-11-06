/**
 * ReasoningRow.tsx
 * 24px 极简单行流式思考行组件（DIM-03 §1.1 规范）。
 *
 * 核心特性：
 * - 严格固定 24px 高度（未展开态 contain: size layout，彻底阻断流式测高风暴）；
 * - 流式运行态：极简状态指示灯 + 文字呼吸微交互（共享 @keyframes crish-text-breathe）+ 512B 尾窗打字追踪；
 * - 终态闭合态：`已思考 3.2 秒 >`，数字等宽对齐 font-variant-numeric: tabular-nums；
 * - 点击展开态：思考体 --reasoning-max-h 封顶 + 内部滚动（HC1 受限滚动区，
 *   展开 = 进入受限滚动区而非全高展开），流式期间贴底跟随、用户上滚后不抢滚；
 * - 独立一键复制纯净思考思维链；
 * - 思考体 DOM 常驻（AN1 机制替换）：折叠只收 grid 行高，收拢完成后槽位挂
 *   hidden="until-found"（浏览器查找命中经 beforematch 自动展开）；不再有
 *   「过渡完卸载 DOM」的两阶段机制，折叠全程零节点移除。
 */
import React, {
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
} from 'react';
import { Button, NumericText, ScrollFadeRegion } from '@/components/ui';
import styles from './ReasoningRow.module.css';
import { StreamingMarkdownView } from './StreamingMarkdownView';
import { Priority } from '../../workers';
import {
  calcAccordionDuration,
  accordionDurationStyle,
  DURATION_ACCORDION_MS,
} from '../../utils/motionTokens';
import { useAccordionViewportGuard } from '../../hooks/useAccordionViewportGuard';
import { useI18n } from '../../i18n';
import { useLiveThoughtTicker } from '../chat-message/liveThoughtTickerContext';
import { useEntranceReveal } from '../motion/useEntranceReveal';


/**
 * 折叠摘要 = 纯文本渲染（HC1 治 L-8）：摘要是标题文本而非正文，
 * 不再走 markdown 解析——段标题中的反引号/星号按字面呈现，
 * 与工具行的纯文本口径一致（D-5 的段间分隔由投影层保证）。
 */
/**
 * 摘要行纯文本化（HC1 · L-8）：剥除行内 markdown 装饰标记（标题前缀、
 * 加粗/斜体/删除线/行内代码），只留字面文本——不再把纯标题文本送进
 * markdown 引擎解析（段标题中的反引号/星号曾被当格式吞掉），与工具行
 * 的纯文本口径一致；「不暴露 Markdown 源码」的可见契约保持不变。
 */
export function stripInlineMarkdownMarkers(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function ReasoningSummaryText({
  text,
  isLive,
}: {
  text: string;
  isLive: boolean;
}) {
  return (
    <span
      className={`${styles.summaryText} ${isLive ? styles.textBreathe : ''}`}
      data-testid="reasoning-summary-markup"
    >
      {stripInlineMarkdownMarkers(text)}
    </span>
  );
}

/**
 * ReasoningRowProps 核心渲染契约（对齐 DIM-03 §1.1）
 */
export interface ReasoningRowProps {
  /** 累积思考思维链全文（可达数十KB） */
  content: string;
  /** 是否处于实时流式思考输出中 */
  isLive?: boolean;
  /** 整轮是否处于模型工作态（吐完所有内容前保持展开，全部完成后自动折叠） */
  isTurnWorking?: boolean;
  /** 思考完成总耗时（毫秒） */
  durationMs?: number;
  /** 多阶段思考轮次索引（如第 1 阶段思考） */
  turnIndex?: number;
  /** 外部受控开合状态（若提供则由上层状态机受控） */
  isOpen?: boolean;
  /** 点击单行切换开合的回调函数 */
  onToggle?: () => void;
  /** 初始默认开合（非受控容灾兼容，缺省为 false） */
  defaultExpanded?: boolean;
  /** 消息唯一 ID（供定位与锚点追溯） */
  messageId?: string;
  /** 思考段开始时间戳（ms；统一入场通道的实况窗判定用） */
  startTime?: number;
  /** 外层容器附加类名 */
  className?: string;
}

/**
 * 思考呈现契约模型（单一真相源 SSOT）
 */
export interface ReasoningPresentation {
  /** 头部徽标/状态文案（如：“思考中”、“已思考”、“已思考 3.2s”） */
  badgeText: string;
  /** 是否需要前置状态圆点（仅流式进行态） */
  hasLiveDot: boolean;
  /** 单行收拢模式下的动态文本预览（展开态恒为空串，彻底阻断内容双份复读） */
  summaryText: string;
  /** 无障碍屏幕阅读器专用 aria-label */
  ariaLabel: string;
  /** 是否允许点击交互 */
  interactive: boolean;
}

export interface ResolveReasoningPresentationOptions {
  isLive: boolean;
  isExpanded: boolean;
  durationMs?: number;
  turnIndex?: number;
  content: string;
  t: (
    key: string,
    fallbackOrParams?: string | Record<string, unknown>,
    params?: Record<string, unknown>
  ) => string;
}

/**
 * 纯逻辑函数：派发思维链在各生命周期状态下的标准呈现契约（零 JSX 补丁、零硬编码）
 */
export function resolveReasoningPresentation(
  opts: ResolveReasoningPresentationOptions
): ReasoningPresentation {
  const { isLive, isExpanded, durationMs, content, t } = opts;

  // 1. 流式运行态
  if (isLive) {
    const label = t('chat.thinking.label', '思考中');
    return {
      badgeText: label,
      hasLiveDot: true,
      summaryText: isExpanded ? '' : extractLatestLine(content),
      ariaLabel: label,
      interactive: true,
    };
  }

  // 2. 终态收敛：静态文案「思考过程」，去耗时秒数（M-07 & R2 规范）
  const badgeText = t('chat.thinking.process', '思考过程');
  const ariaLabel = badgeText;

  return {
    badgeText,
    hasLiveDot: false,
    summaryText: isExpanded ? '' : extractFirstLine(content),
    ariaLabel,
    interactive: Boolean(content.trim()),
  };
}

/**
 * 512 字节尾窗切片算法：提取流式思考最新行
 * 复杂度严格保证：时间复杂度 O(1)，空间开销 ≤ 512B
 */
export function extractLatestLine(text: string): string {
  if (!text) return '';
  // 1. 仅截取尾部最多 512 个字符，彻底避开全量大文本扫描与 V8 GC 压力
  const tail = text.length > 512 ? text.slice(-512) : text;
  // 2. 清除末尾换行与空白
  const trimmed = tail.trimEnd();
  if (!trimmed) return '';
  // 3. 在至多 512 字符的小缓冲区中逆向寻址最后一个换行符（兼容真实换行与 JSX 字面量 \n）
  const lastReal = Math.max(
    trimmed.lastIndexOf('\n'),
    trimmed.lastIndexOf('\r')
  );
  const lastLit = trimmed.lastIndexOf('\\n');
  let line = trimmed;
  if (lastReal >= 0 && lastLit >= 0) {
    line =
      lastReal > lastLit
        ? trimmed.slice(lastReal + 1)
        : trimmed.slice(lastLit + 2);
  } else if (lastReal >= 0) {
    line = trimmed.slice(lastReal + 1);
  } else if (lastLit >= 0) {
    line = trimmed.slice(lastLit + 2);
  }
  // 4. 返回清洗后的单行文本
  return line.trim();
}

/**
 * 512 字节首窗切片算法：提取终态首行主题
 * 复杂度严格保证：时间复杂度 O(1)，空间开销 ≤ 512B
 */
export function extractFirstLine(text: string): string {
  if (!text) return '';
  // 1. 仅截取头部最多 512 个字符
  const head = text.length > 512 ? text.slice(0, 512) : text;
  // 2. 寻找第一个有效换行（兼容真实换行与 JSX 字面量 \n）
  const realIndices = [head.indexOf('\n'), head.indexOf('\r')].filter(
    (i) => i >= 0
  );
  const firstReal = realIndices.length > 0 ? Math.min(...realIndices) : -1;
  const firstLit = head.indexOf('\\n');

  let firstNewline = -1;
  let cutLen = 1;

  if (firstReal >= 0 && firstLit >= 0) {
    if (firstReal < firstLit) {
      firstNewline = firstReal;
      cutLen = 1;
    } else {
      firstNewline = firstLit;
      cutLen = 2;
    }
  } else if (firstReal >= 0) {
    firstNewline = firstReal;
    cutLen = 1;
  } else if (firstLit >= 0) {
    firstNewline = firstLit;
    cutLen = 2;
  }

  const line = firstNewline >= 0 ? head.slice(0, firstNewline) : head;
  const trimmed = line.trim();
  // 若首行为空（例如模型开头换行），向下顺延寻找首个实质文本行
  if (!trimmed && firstNewline >= 0) {
    const remaining = head.slice(firstNewline + cutLen).trimStart();
    return extractFirstLine(remaining);
  }
  return trimmed;
}

export const ReasoningRow: React.FC<ReasoningRowProps> = ({
  content,
  isLive = false,
  isTurnWorking = false,
  durationMs,
  turnIndex,
  isOpen,
  onToggle,
  defaultExpanded,
  messageId,
  startTime,
  className = '',
}) => {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 统一入场通道：思考行容器 fade 入场（展开高度仍归本行 accordion
  // 机制，通道不接管高度，避免双轨）。
  const entrance = useEntranceReveal({
    key: `thought:${messageId ?? ''}:${turnIndex ?? 0}`,
    eventTs: startTime,
    variant: 'fade',
  });
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [userInteracted, setUserInteracted] = useState(false);
  const [userExpanded, setUserExpanded] = useState(false);
  const [accordionDuration, setAccordionDuration] = useState<number>(
    DURATION_ACCORDION_MS
  );

  // 运行态思考承载（2026-11-06 第 9 条）：本段思考已由组头 ticker 承载时，
  // 本行 live 摘要抑制（只留「思考中」标签与状态点），杜绝双动态通道。
  const { hosted: thoughtHostedByTicker } = useLiveThoughtTicker();

  // 视口保护：长思维链收拢时防迷失
  const { triggerViewportRecovery } = useAccordionViewportGuard(containerRef);

  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (prevIsOpenRef.current === true && isOpen === false) {
      const h = bodyRef.current?.getBoundingClientRect().height ?? 0;
      setAccordionDuration(calcAccordionDuration(h, false));
      triggerViewportRecovery();
    } else if (isOpen === true) {
      setAccordionDuration(calcAccordionDuration(400, true));
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, triggerViewportRecovery]);

  // 默认开合策略（2026-11-06 用户裁决第 8 条，取代 2026-09-18 / 10-13
  // 「工作态默认展开」旧口径）：
  // 1. 若外部显式受控传入 isOpen，遵循 isOpen；
  // 2. 若用户曾手动交互（主动打开/关闭），持久保持用户的意图，
  //    运行中内容到达与工作态翻转都不改变它，生成完也不自动关闭；
  // 3. 其余一切情形（模型工作态、终态、历史消息）一律默认折叠为
  //    24px 单行——运行中思考在组头 ticker 呈现（第 9 条），本行不自动展开。
  // 注：isTurnWorking / defaultExpanded 入参保留以兼容既有调用方，
  // 自本裁决起不再驱动展开判定（退役清理归后续专批，本批不动调用面）。
  const isExpanded = useMemo(() => {
    if (isOpen !== undefined) return isOpen;
    if (userInteracted) return userExpanded;
    return false;
  }, [isOpen, userInteracted, userExpanded]);

  // R11 §5.1：折叠摘要从已显现文本派生——展开体（StreamingMarkdownView）
  // 经 onRevealedTextChange 回传同一 revealed 前缀，摘要不单独定速、
  // 不领先于正文的实际显现进度（派生一致性优先）。
  const [revealedText, setRevealedText] = useState(content);
  const handleRevealedTextChange = useCallback((revealed: string) => {
    setRevealedText(revealed);
  }, []);

  // 派发单一真相源呈现契约（纯逻辑解耦，零 JSX 补丁，零标点噪点）
  const presentation = useMemo(() => {
    const base = resolveReasoningPresentation({
      isLive,
      isExpanded,
      durationMs,
      turnIndex,
      content,
      t,
    });
    if (!isLive || isExpanded) return base;
    // 思考已被同段组头 ticker 承载（第 9 条）：本行只留静态标签，
    // 不再呈现会逐行变化的摘要——全段唯一动态面归 ticker。
    if (thoughtHostedByTicker) return { ...base, summaryText: '' };
    // live 折叠态：摘要尾窗改从已显现前缀取最新行（与展开体同源）
    return { ...base, summaryText: extractLatestLine(revealedText) };
  }, [
    isLive,
    isExpanded,
    durationMs,
    turnIndex,
    content,
    t,
    revealedText,
    thoughtHostedByTicker,
  ]);

  // ── AN1 隐藏协调（与 FoldableProcessSection 同构的已验证模式）──
  // 思考体常驻 DOM：展开时摘除 hidden；折叠的 grid transitionend
  // （grid-template-rows）是挂 hidden="until-found" 的主触发，同钟定时器
  // 只是兜底触发——兜底定时器只补 hidden 属性，永不卸载任何 DOM 节点
  // （思考体在折叠态保持挂载，勿改回过渡后卸载的旧两阶段路线）；
  // 浏览器在 until-found 内容中命中查找时发 beforematch → 自动展开。
  const gridRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const expandedRef = useRef(isExpanded);
  expandedRef.current = isExpanded;

  const setSlotRef = useCallback((node: HTMLDivElement | null) => {
    slotRef.current = node;
    if (!node) return;
    if (expandedRef.current) node.removeAttribute('hidden');
    else node.setAttribute('hidden', 'until-found');
  }, []);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return undefined;
    if (isExpanded) {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      slot.removeAttribute('hidden');
      return undefined;
    }
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      if (!expandedRef.current) {
        slotRef.current?.setAttribute('hidden', 'until-found');
      }
    }, accordionDuration);
    return () => {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
    };
  }, [isExpanded, accordionDuration]);

  const handleGridTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.target !== gridRef.current) return;
      if (event.propertyName !== 'grid-template-rows') return;
      if (expandedRef.current) return;
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      slotRef.current?.setAttribute('hidden', 'until-found');
    },
    []
  );

  // 浏览器查找命中 until-found 隐藏内容 → 自动展开（受控模式只通知上层）
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return undefined;
    const handleBeforeMatch = () => {
      if (isOpen === undefined) {
        setUserInteracted(true);
        setUserExpanded(true);
        setAccordionDuration(calcAccordionDuration(400, true));
      }
      onToggle?.();
    };
    slot.addEventListener('beforematch', handleBeforeMatch);
    return () => {
      slot.removeEventListener('beforematch', handleBeforeMatch);
    };
  }, [isOpen, onToggle]);

  // HC1/F1：思考体滚动宿主的边缘渐隐四态——经 ScrollFadeRegion 组件
  // 接入（渲染段的 reasoningBody 即组件宿主，bodyRef 经 ref 转发落
  // 宿主，测高 / 滚动跟随的既有消费方不变；active=isExpanded）。

  // HC1：思考体封顶后的流式贴底跟随——距底 <48px 视为贴底意图，
  // 用户手动上滚离开底部后不再抢滚（与消息列表 follow 纪律同构）
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isExpanded]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !isLive || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [content, isLive]);

  const handleToggle = useCallback(() => {
    if (!presentation.interactive) return;
    setUserInteracted(true);
    if (isExpanded) {
      const h = bodyRef.current?.getBoundingClientRect().height ?? 0;
      setAccordionDuration(calcAccordionDuration(h, false));
      triggerViewportRecovery();
      setUserExpanded(false);
    } else {
      setAccordionDuration(calcAccordionDuration(400, true));
      setUserExpanded(true);
    }
    onToggle?.();
  }, [isExpanded, onToggle, presentation.interactive, triggerViewportRecovery]);

  return (
    <div
      ref={(el) => {
        containerRef.current = el;
        entrance.rootRef(el);
      }}
      className={`${styles.reasoningContainer} ${isLive ? styles.isLive : ''} ${className}${entrance.entering ? ' crish-entrance-fade' : ''}`}
      data-expanded={isExpanded ? 'true' : 'false'}
      data-live={isLive ? 'true' : undefined}
      data-message-id={messageId}
      data-testid="reasoning-container"
      data-entering={entrance.entering ? 'true' : undefined}
      onAnimationEnd={entrance.handleAnimationEnd}
      style={{
        ...accordionDurationStyle(accordionDuration),
        ...(entrance.entering
          ? ({
              '--reveal-delay': `${entrance.delayMs}ms`,
            } as React.CSSProperties)
          : null),
      }}
    >
      <Button
        type="button"
        variant="ghost"
        className={styles.reasoningRow}
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-label={presentation.ariaLabel}
      >
        {presentation.hasLiveDot ? (
          <span className={styles.reasoningSlotIco}>
            <span
              className={styles.statusDot}
              aria-hidden
              data-testid="status-dot"
            />
          </span>
        ) : null}

        <span
          className={
            presentation.hasLiveDot
              ? styles.reasoningLabel
              : styles.durationBadge
          }
          data-testid="reasoning-badge"
        >
          <NumericText text={presentation.badgeText} />
        </span>

        {presentation.summaryText ? (
          <span className={styles.reasoningSummary} data-follow-end="true">
            <ReasoningSummaryText
              text={presentation.summaryText}
              isLive={isLive}
            />
          </span>
        ) : null}

        <span
          className={`${styles.chevron} ${isExpanded ? styles.isOpen : ''}`}
          aria-hidden
          data-testid="chevron"
        >
          ›
        </span>
      </Button>

      {/* 思考体常驻 DOM（AN1）：grid > slot > body 三层与 testid 保持不变，
          折叠只收行高 + 槽位 hidden="until-found"，永不卸载 */}
      <div
        ref={gridRef}
        className={styles.reasoningExpandGrid}
        data-testid="reasoning-grid"
        onTransitionEnd={handleGridTransitionEnd}
      >
        <div ref={setSlotRef} className={styles.reasoningExpandSlot}>
          <ScrollFadeRegion
            ref={bodyRef}
            active={isExpanded}
            className={styles.reasoningBody}
            innerClassName={styles.reasoningContent}
            data-testid="reasoning-body"
          >
            <StreamingMarkdownView
              text={content}
              isStreaming={isLive}
              priority={Priority.Low}
              messageId={messageId ? `${messageId}-reasoning` : undefined}
              pacingProfile="thinking"
              onRevealedTextChange={handleRevealedTextChange}
            />
          </ScrollFadeRegion>
        </div>
      </div>
    </div>
  );
};
