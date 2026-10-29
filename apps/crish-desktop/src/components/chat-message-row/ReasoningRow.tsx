/**
 * ReasoningRow.tsx
 * 24px 极简单行流式思考行组件（DIM-03 §1.1 规范）。
 *
 * 核心特性：
 * - 严格固定 24px 高度（未展开态 contain: size layout，彻底阻断流式测高风暴）；
 * - 流式运行态：极简状态指示灯 + 扫光微交互（@keyframes sweep-shine）+ 512B 尾窗打字追踪；
 * - 终态闭合态：`已思考 3.2s >`，数字等宽对齐 font-variant-numeric: tabular-nums；
 * - 点击展开态：自然向下融入主文档流，零内部滚动条，无 168px 限制，滚动交由外层唯一滚动宿主；
 * - 独立一键复制纯净思考思维链；
 * - 两阶段平滑收敛：流式思考结束时 160ms CSS Grid 高度收缩，合拢后容器高度自然收敛于 24px，消除视口跳跃。
 */
import React, {
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
} from 'react';
import { Button } from '@/components/ui';
import styles from './ReasoningRow.module.css';
import { StreamingMarkdownView } from './StreamingMarkdownView';
import { Priority } from '../../workers';
import { useStreamingMarkdownResult } from '../../api/markdown/useMarkdownRender';
import { MarkdownSurface } from '../markdown/MarkdownSurface';
import * as motionTokens from '../../utils/motionTokens';
import { DURATION_ACCORDION_MS } from '../../utils/motionTokens';
import { useAccordionViewportGuard } from '../../hooks/useAccordionViewportGuard';
import { useI18n } from '../../i18n';

/**
 * 距离自适应手风琴折叠展开物理时长计算器（带 motionTokens 动态回退）
 */
function calcAccordionDuration(height: number, isOpening: boolean): number {
  if (
    typeof (motionTokens as Record<string, unknown>).calcAccordionDuration ===
    'function'
  ) {
    return (
      (motionTokens as Record<string, unknown>).calcAccordionDuration as (
        h: number,
        o: boolean
      ) => number
    )(height, isOpening);
  }
  const safeHeight = Math.max(0, Number.isFinite(height) ? height : 0);
  if (isOpening) {
    const raw = 180 + 90 * Math.log(1 + safeHeight / 120);
    return Math.round(Math.min(480, Math.max(180, raw)));
  } else {
    const raw = 150 + 65 * Math.log(1 + safeHeight / 120);
    return Math.round(Math.min(350, Math.max(150, raw)));
  }
}

function ReasoningSummaryMarkup({
  markdown,
  isLive,
}: {
  markdown: string;
  isLive: boolean;
}) {
  const { html } = useStreamingMarkdownResult(
    markdown,
    'chat',
    Boolean(markdown)
  );

  return (
    <MarkdownSurface
      as="span"
      variant="chat"
      isActive={isLive}
      className={`${styles.summaryText} ${isLive ? styles.sweepShine : ''}`}
      html={html}
      dataAttributes={{ 'data-testid': 'reasoning-summary-markup' }}
    />
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

  // 2. 终态收敛：格式化耗时与身份徽标
  let badgeText = t('chat.thinking.completed', '已思考');
  if (durationMs != null && durationMs > 0) {
    const sec = (durationMs / 1000).toFixed(1);
    badgeText = t('chat.thinking.durationShort', `已思考 ${sec}s`, {
      duration: sec,
    });
  }

  const ariaLabel =
    durationMs != null && durationMs > 0
      ? badgeText
      : t('chat.thinking.process', '思考过程');

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
  className = '',
}) => {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [userInteracted, setUserInteracted] = useState(false);
  const [userExpanded, setUserExpanded] = useState(false);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [prevTurnWorking, setPrevTurnWorking] = useState(isTurnWorking);
  const [accordionDuration, setAccordionDuration] = useState<number>(
    DURATION_ACCORDION_MS
  );

  // 视口保护：长思维链收拢时防迷失
  const { triggerViewportRecovery } = useAccordionViewportGuard(containerRef);

  // 终态跃迁状态同步：当模型整轮工作态结束（isTurnWorking 从 true 转为 false）
  // 且未被外部显式受控或用户手动交互覆盖时，进入第一阶段折叠过渡态（isCollapsing: true），
  // 保留 DOM 结构由 CSS Grid 执行平滑收缩，彻底消除视口跳跃。
  // 天然兼容生产环境与既有单元测试，零测试环境特判分支。
  if (prevTurnWorking !== isTurnWorking) {
    setPrevTurnWorking(isTurnWorking);
    if (
      prevTurnWorking &&
      !isTurnWorking &&
      isOpen === undefined &&
      !userInteracted &&
      defaultExpanded !== false
    ) {
      const h = bodyRef.current?.getBoundingClientRect().height ?? 0;
      setAccordionDuration(calcAccordionDuration(h, false));
      triggerViewportRecovery();
      setIsCollapsing(true);
    } else if (isTurnWorking && isCollapsing) {
      setIsCollapsing(false);
    }
  }

  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (prevIsOpenRef.current === true && isOpen === false) {
      const h = bodyRef.current?.getBoundingClientRect().height ?? 0;
      setAccordionDuration(calcAccordionDuration(h, false));
      triggerViewportRecovery();
      setIsCollapsing(true);
    } else if (isOpen === true) {
      setAccordionDuration(calcAccordionDuration(400, true));
      setIsCollapsing(false);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, triggerViewportRecovery]);

  // 第二阶段完全卸载：物理过渡完成后解除 DOM 挂载
  useEffect(() => {
    if (!isCollapsing) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setIsCollapsing(false);
    }, accordionDuration);
    return () => {
      window.clearTimeout(timer);
    };
  }, [isCollapsing, accordionDuration]);

  // 默认开合策略（2026-09-18 / 2026-10-13 用户裁决）：
  // 1. 若外部显式受控传入 isOpen，遵循 isOpen；
  // 2. 若用户曾手动交互（主动打开/关闭），持久保持用户的意图，生成完也不自动关闭；
  // 3. 模型工作态 (isTurnWorking) 期间：默认展开显示思考思维链（除非 defaultExpanded 显式为 false）；
  // 4. 终态 (!isTurnWorking，生成完成或关闭对话再打开的历史消息)：一律默认折叠收起为 24px 单行。
  const isExpanded = useMemo(() => {
    if (isOpen !== undefined) return isOpen;
    if (userInteracted) return userExpanded;
    if (isTurnWorking) return defaultExpanded ?? true;
    return false;
  }, [isOpen, userInteracted, userExpanded, isTurnWorking, defaultExpanded]);

  // 派发单一真相源呈现契约（纯逻辑解耦，零 JSX 补丁，零标点噪点）
  const presentation = useMemo(
    () =>
      resolveReasoningPresentation({
        isLive,
        isExpanded,
        durationMs,
        turnIndex,
        content,
        t,
      }),
    [isLive, isExpanded, durationMs, turnIndex, content, t]
  );

  const handleToggle = useCallback(() => {
    if (!presentation.interactive) return;
    setUserInteracted(true);
    if (isExpanded) {
      const h = bodyRef.current?.getBoundingClientRect().height ?? 0;
      setAccordionDuration(calcAccordionDuration(h, false));
      triggerViewportRecovery();
      setUserExpanded(false);
      setIsCollapsing(true);
    } else {
      setAccordionDuration(calcAccordionDuration(400, true));
      setUserExpanded(true);
      setIsCollapsing(false);
    }
    onToggle?.();
  }, [isExpanded, onToggle, presentation.interactive, triggerViewportRecovery]);

  return (
    <div
      ref={containerRef}
      className={`${styles.reasoningContainer} ${isLive ? styles.isLive : ''} ${className}`}
      data-expanded={isExpanded ? 'true' : 'false'}
      data-collapsing={isCollapsing ? 'true' : undefined}
      data-live={isLive ? 'true' : undefined}
      data-message-id={messageId}
      data-testid="reasoning-container"
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
          <span
            className={styles.statusDot}
            aria-hidden
            data-testid="status-dot"
          />
        ) : null}

        <span
          className={
            presentation.hasLiveDot
              ? styles.reasoningLabel
              : styles.durationBadge
          }
          data-testid="reasoning-badge"
        >
          {presentation.badgeText}
        </span>

        {presentation.summaryText ? (
          <span className={styles.reasoningSummary} data-follow-end="true">
            <ReasoningSummaryMarkup
              markdown={presentation.summaryText}
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

      {(isExpanded || isCollapsing) && (
        <div
          className={styles.reasoningExpandGrid}
          style={
            {
              '--accordion-duration': `${accordionDuration}ms`,
            } as React.CSSProperties
          }
          data-testid="reasoning-grid"
        >
          <div className={styles.reasoningExpandSlot}>
            <div
              ref={bodyRef}
              className={styles.reasoningBody}
              data-testid="reasoning-body"
            >
              <div className={styles.reasoningContent}>
                <StreamingMarkdownView
                  text={content}
                  isStreaming={isLive}
                  priority={Priority.Low}
                  messageId={messageId ? `${messageId}-reasoning` : undefined}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
