// markdown 正文渲染（MD2)：自有 AST → RN 组件树，样式全走 theme token
// （灰度分层、无边框滥用、代码块等宽、表格横滑；守卫禁止裸色值 / 数字圆角 /
// 数字字号，本文件一律经 useTheme 取档）。
// 口径（审计 §C)：
// - 静态（streaming=false）走 parseMarkdown 全量解析；流式走
//   prepareStreamingMarkdown：封口块最终形态按内容签名 memo、尾块分治呈现；
// - 超限降级：全文超 MARKDOWN_DEGRADE_THRESHOLD 时降级纯文本 + 可见标注
//   （不静默），原文仍可长按选择；
// - 链接一律经 openLink 统一出口（协议白名单在出口层），呈现层不裸调 openURL；
// - 代码块：常驻顶栏（语言标签 + 14dp 复制按钮）+ 居中极浅发丝分割线 +
//   封口后词法高亮（批 E；domain/pure/markdown/highlight，色走 theme.syntax)，
//   流式尾块保持等宽原文；复制成功 1500ms 翡翠绿对勾反馈 + 触感，支持长按选择；
// - 公式 / Mermaid：封口后经本地 WebView 渲染（WebContentBlock，批 E)，
//   尾块 / 失败回落原文；整段展示公式在 AST 层识别（displayMath)，与正文
//   混排的行内公式保持原文（RN Text 内无块级渲染面，诚实口径）；
// - markdown 独立成段图：真加载（MarkdownImage，批 E；几何见 FN-3 口径），
//   与正文混排的行内图仍为文字标（同上，无块级面可嵌）。
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ColorValue,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { useTheme, type Theme } from '@/adapters/platform/theme';
import { openLink } from '@/adapters/platform/openLink';
import { copyTextToClipboard } from '@/adapters/platform/clipboard';
import { haptics } from '@/adapters/platform/haptics';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import { parseMarkdown } from '@/domain/pure/markdown/parseMarkdown';
import { prepareStreamingMarkdown } from '@/domain/pure/markdown/closeDraft';
import {
  tokenizeCode,
  type CodeTokenRole,
} from '@/domain/pure/markdown/highlight';
import {
  extractDisplayMath,
  isMathFenceLang,
  isMermaidFenceLang,
} from '@/domain/pure/markdown/displayMath';
import type { MdBlock, MdListItem, MdSpan } from '@/domain/pure/markdown/types';
import { AppText, Icon } from '@/presentation/ui';
import { MarkdownImage } from './MarkdownImage';
import { WebContentBlock } from './WebContentBlock';
import { StreamingTailText } from './StreamingTailText';
import { CitationPill } from './CitationPill';
import type { WebSearchSource } from '@crish/shared-types';
import { parseMessageCitations } from '@crish/shared-utils';

/** 超限降级线（字符数）：超过即纯文本 + 标注（审计 C.4，真机定标后写死） */
export const MARKDOWN_DEGRADE_THRESHOLD = 50_000;

export interface MarkdownTextProps {
  text: string;
  /** 流式期：走草稿分治（封口块定型 + 尾块分治）；false = 终态全量解析 */
  streaming?: boolean;
  /** 是否开启末端模糊渐显 (缺省 false；由 StreamingText 显式传入控制) */
  tailGradient?: boolean;
  /** 正文基础样式（缺省 theme.type.chat + textPrimary；气泡等场景由调用方透传既有 Text 样式） */
  baseStyle?: StyleProp<TextStyle>;
  /** 流式光标符号（由 StreamingText 透传；落在最后一个块的末尾） */
  cursorSymbol?: string;
  cursorTestID?: string;
  cursorStyle?: StyleProp<TextStyle>;
  testID?: string;
  /** 可选的事实源列表（若传入，角标将自动关联对应事实源） */
  sources?: readonly WebSearchSource[];
  /** 点击正文引文角标时的回调 */
  onCitationPress?: (index: number, source?: WebSearchSource) => void;
  /** 当前处于联动高亮状态的引文角标序号 */
  highlightedCitationIndex?: number;
}

/** 渲染上下文：正文色、气泡标记与正文引文联动 */
interface RenderCtx {
  color: ColorValue;
  inBubble: boolean;
  sources?: readonly WebSearchSource[];
  onCitationPress?: (index: number, source?: WebSearchSource) => void;
  highlightedCitationIndex?: number;
}

/**
 * 光标盒子：渲染前由 blockConsumesCursor 预判末块能否行内承载，能承载则随
 * 末块下发消费，不能承载（代码/表格/分割线/图片）则由根组件独立兜底渲染。
 * 禁止用「渲染期回写 consumed」判定——子组件渲染晚于父级 JSX 求值，必然双渲。
 */
interface CursorBox {
  node: ReactNode;
}

/** 末块能否把光标嵌进行内流（与 BlockNode/ListBlock/QuoteBlock 的下发路径镜像） */
function blockConsumesCursor(block: MdBlock): boolean {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return true;
    case 'list': {
      const lastItem = block.items[block.items.length - 1];
      if (!lastItem || lastItem.blocks.length === 0) return false;
      return blockConsumesCursor(lastItem.blocks[lastItem.blocks.length - 1]!);
    }
    case 'quote': {
      if (block.blocks.length === 0) return false;
      return blockConsumesCursor(block.blocks[block.blocks.length - 1]!);
    }
    default:
      return false;
  }
}

function blockSignature(block: MdBlock): string {
  return JSON.stringify(block);
}

export function MarkdownText({
  text,
  streaming = false,
  tailGradient = false,
  baseStyle,
  cursorSymbol,
  cursorTestID,
  cursorStyle,
  testID,
  sources,
  onCitationPress,
  highlightedCitationIndex,
}: MarkdownTextProps) {
  const theme = useTheme();
  const degraded = text.length > MARKDOWN_DEGRADE_THRESHOLD;

  // sealedCount：流式期前 sealedCount 块为封口块（最终形态，可高亮 /
  // WebView 化)，其后为生长尾块（保持原文呈现，批 E 封口教义）；静态期全封口
  const { blocks, sealedCount } = useMemo((): {
    blocks: MdBlock[] | null;
    sealedCount: number;
  } => {
    if (degraded) return { blocks: null, sealedCount: 0 };
    if (streaming) {
      const prepared = prepareStreamingMarkdown(text);
      return {
        blocks: [...prepared.sealed, ...prepared.tail],
        sealedCount: prepared.sealed.length,
      };
    }
    const all = parseMarkdown(text);
    return { blocks: all, sealedCount: all.length };
  }, [text, streaming, degraded]);

  const flatBase = useMemo(
    () => (baseStyle ? StyleSheet.flatten(baseStyle) : undefined),
    [baseStyle]
  );
  const ctx: RenderCtx = {
    color: flatBase?.color ?? theme.colors.textPrimary,
    inBubble: flatBase?.color === theme.colors.bubbleUserText,
    sources,
    onCitationPress,
    highlightedCitationIndex,
  };

  const cursorBox: CursorBox = {
    node:
      streaming && cursorSymbol ? (
        <Text testID={cursorTestID} style={cursorStyle}>
          {` ${cursorSymbol}`}
        </Text>
      ) : null,
  };

  if (degraded) {
    return (
      <View testID={testID} style={{ gap: theme.space.sm }}>
        <AppText
          variant="caption"
          color="textTertiary"
          testID="markdown-degraded-note"
        >
          内容过长，已按纯文本显示
        </AppText>
        <StreamingTailText
          selectable
          text={text}
          streaming={streaming}
          tailGradient={tailGradient}
          style={[theme.type.chat, { color: ctx.color }, flatBase]}
        />
        {cursorBox.node}
      </View>
    );
  }

  const list = blocks ?? [];
  const lastBlock = list[list.length - 1];
  const cursorInline = !!lastBlock && blockConsumesCursor(lastBlock);
  return (
    <View testID={testID} style={{ gap: theme.space.md }}>
      {list.map((block, index) => {
        const isLast = index === list.length - 1;
        return (
          <MarkdownBlockView
            key={index}
            block={block}
            ctx={ctx}
            sealed={index < sealedCount}
            tailGradient={isLast && streaming ? tailGradient : false}
            cursorBox={isLast && cursorInline ? cursorBox : null}
          />
        );
      })}
      {cursorBox.node && !cursorInline ? cursorBox.node : null}
    </View>
  );
}

/** 单块渲染（memo：签名不变不重渲——封口块在流式期间靠此保持静止；
 * sealed 翻转（尾块封口）须击穿 memo 触发着色 / WebView 化，故入比较） */
const MarkdownBlockView = memo(
  function MarkdownBlockView({
    block,
    ctx,
    cursorBox,
    sealed,
    tailGradient,
  }: {
    block: MdBlock;
    ctx: RenderCtx;
    cursorBox: CursorBox | null;
    sealed: boolean;
    tailGradient?: boolean;
  }) {
    return (
      <BlockNode
        block={block}
        ctx={ctx}
        cursorBox={cursorBox}
        sealed={sealed}
        tailGradient={tailGradient}
      />
    );
  },
  (prev, next) =>
    blockSignature(prev.block) === blockSignature(next.block) &&
    prev.ctx.color === next.ctx.color &&
    prev.ctx.inBubble === next.ctx.inBubble &&
    prev.ctx.sources === next.ctx.sources &&
    prev.ctx.onCitationPress === next.ctx.onCitationPress &&
    prev.ctx.highlightedCitationIndex === next.ctx.highlightedCitationIndex &&
    prev.sealed === next.sealed &&
    prev.tailGradient === next.tailGradient &&
    (prev.cursorBox?.node ?? null) === (next.cursorBox?.node ?? null)
);

function BlockNode({
  block,
  ctx,
  cursorBox,
  sealed,
  tailGradient,
}: {
  block: MdBlock;
  ctx: RenderCtx;
  cursorBox: CursorBox | null;
  sealed: boolean;
  tailGradient?: boolean;
}) {
  const theme = useTheme();
  switch (block.type) {
    case 'paragraph': {
      // 整段展示公式：封口后经 WebView KaTeX 渲染（批 E)；尾段不转换
      if (sealed) {
        const math = extractDisplayMath(block.spans);
        if (math !== null) {
          return (
            <WebContentBlock
              kind="math"
              source={math}
              testID="markdown-web-math"
            />
          );
        }
      }
      return (
        <Text style={[theme.type.chat, { color: ctx.color }]}>
          <SpanNodes
            spans={block.spans}
            ctx={ctx}
            tailGradient={tailGradient}
          />
          {consumeCursor(cursorBox)}
        </Text>
      );
    }
    case 'heading':
      return (
        <Text style={[headingStyle(theme, block.level), { color: ctx.color }]}>
          <SpanNodes
            spans={block.spans}
            ctx={ctx}
            tailGradient={tailGradient}
          />
          {consumeCursor(cursorBox)}
        </Text>
      );
    case 'code':
      // Mermaid / 公式围栏：封口后经 WebView 渲染（批 E)；尾块走代码块原文
      if (sealed && isMermaidFenceLang(block.lang)) {
        return (
          <WebContentBlock
            kind="mermaid"
            source={block.text}
            testID="markdown-web-mermaid"
          />
        );
      }
      if (sealed && isMathFenceLang(block.lang)) {
        return (
          <WebContentBlock
            kind="math"
            source={block.text}
            testID="markdown-web-math"
          />
        );
      }
      return (
        <CodeBlock
          lang={block.lang}
          text={block.text}
          sealed={sealed}
          tailGradient={tailGradient}
        />
      );
    case 'list':
      return (
        <ListBlock
          ordered={block.ordered}
          start={block.start}
          items={block.items}
          ctx={ctx}
          cursorBox={cursorBox}
          sealed={sealed}
          tailGradient={tailGradient}
        />
      );
    case 'quote':
      return (
        <QuoteBlock
          blocks={block.blocks}
          ctx={ctx}
          cursorBox={cursorBox}
          sealed={sealed}
          tailGradient={tailGradient}
        />
      );
    case 'table':
      return <TableBlock block={block} ctx={ctx} />;
    case 'hr':
      return (
        <View
          style={{
            // 分隔线口径（2026-11-02 裁决：更浅更细）：发丝宽 + hairline 色
            height: StyleSheet.hairlineWidth,
            backgroundColor: theme.colors.hairline,
          }}
        />
      );
    case 'image':
      return (
        <MarkdownImage
          source={block.src}
          alt={block.alt}
          testID="markdown-image"
          placeholderTestID="markdown-image-placeholder"
        />
      );
  }
}

function consumeCursor(cursorBox: CursorBox | null): ReactNode {
  if (!cursorBox || !cursorBox.node) return null;
  return cursorBox.node;
}

function headingStyle(theme: Theme, level: 1 | 2 | 3 | 4 | 5 | 6): TextStyle {
  switch (level) {
    case 1:
      return theme.type.title;
    case 2:
      return theme.type.mdHeading2;
    case 3:
      return theme.type.bodyStrong;
    case 4:
      return { ...theme.type.chat, fontWeight: '700' };
    case 5:
      return { ...theme.type.footnote, fontWeight: '700' };
    case 6:
      return { ...theme.type.caption, fontWeight: '700' };
  }
}

/** 行内 span 树 → 嵌套 Text（strong/em/del/code/link/image/break) */
function SpanNodes({
  spans,
  ctx,
  tailGradient,
}: {
  spans: MdSpan[];
  ctx: RenderCtx;
  tailGradient?: boolean;
}) {
  const theme = useTheme();

  // 若开启末端渐显，定位到最后一个可承载渐变的 text span
  let lastTextSpanIndex = -1;
  if (tailGradient) {
    for (let i = spans.length - 1; i >= 0; i--) {
      if (spans[i]!.type === 'text') {
        lastTextSpanIndex = i;
        break;
      }
    }
  }

  return (
    <>
      {spans.map((span, index) => {
        const isLastSpan = index === spans.length - 1;
        switch (span.type) {
          case 'text': {
            if (tailGradient && index === lastTextSpanIndex) {
              return (
                <StreamingTailText
                  key={index}
                  text={span.text}
                  streaming
                  tailGradient
                />
              );
            }
            const { segments } = parseMessageCitations(span.text, ctx.sources);
            if (segments.length === 0) {
              return span.text;
            }
            if (segments.length === 1 && segments[0]!.type === 'text') {
              return span.text;
            }
            return (
              <Fragment key={index}>
                {segments.map((seg, segIndex) => {
                  if (seg.type === 'text') {
                    return seg.text;
                  }
                  const citeIndex = seg.index ?? seg.citationIndex ?? 0;
                  const isHighlighted =
                    ctx.highlightedCitationIndex !== undefined &&
                    ctx.highlightedCitationIndex === citeIndex;
                  return (
                    <CitationPill
                      key={segIndex}
                      index={citeIndex}
                      citation={seg.citation}
                      highlighted={isHighlighted}
                      onPress={
                        ctx.onCitationPress
                          ? (idx) => {
                              const matchedSource =
                                (seg.citation?.sourceId &&
                                  ctx.sources?.find(
                                    (s) => s.id === seg.citation?.sourceId
                                  )) ||
                                (idx > 0 && ctx.sources
                                  ? ctx.sources[idx - 1]
                                  : undefined);
                              ctx.onCitationPress?.(idx, matchedSource);
                            }
                          : undefined
                      }
                    />
                  );
                })}
              </Fragment>
            );
          }
          case 'break':
            return '\n';
          case 'strong':
            return (
              <Text key={index} style={{ fontWeight: '700' }}>
                <SpanNodes
                  spans={span.children}
                  ctx={ctx}
                  tailGradient={isLastSpan ? tailGradient : false}
                />
              </Text>
            );
          case 'em':
            return (
              <Text key={index} style={{ fontStyle: 'italic' }}>
                <SpanNodes
                  spans={span.children}
                  ctx={ctx}
                  tailGradient={isLastSpan ? tailGradient : false}
                />
              </Text>
            );
          case 'del':
            return (
              <Text key={index} style={{ textDecorationLine: 'line-through' }}>
                <SpanNodes
                  spans={span.children}
                  ctx={ctx}
                  tailGradient={isLastSpan ? tailGradient : false}
                />
              </Text>
            );
          case 'code':
            return (
              <Text
                key={index}
                style={[
                  theme.type.mono,
                  {
                    backgroundColor: ctx.inBubble
                      ? theme.colors.fillPressed
                      : theme.colors.surfaceGrouped,
                    color: ctx.inBubble
                      ? theme.colors.bubbleUserText
                      : theme.colors.textPrimary,
                    borderRadius: theme.radius.bubbleTail,
                    overflow: 'hidden',
                    paddingHorizontal: 5,
                    paddingVertical: 1.5,
                  },
                ]}
              >
                {span.text}
              </Text>
            );
          case 'link':
            return (
              <Text
                key={index}
                style={{ color: theme.colors.brand }}
                onPress={() => {
                  void openLink(span.href);
                }}
              >
                <SpanNodes
                  spans={span.children}
                  ctx={ctx}
                  tailGradient={isLastSpan ? tailGradient : false}
                />
              </Text>
            );
          case 'image':
            return (
              <Text key={index} style={{ color: theme.colors.textTertiary }}>
                {span.alt !== '' ? `[图片] ${span.alt}` : '[图片]'}
              </Text>
            );
        }
      })}
    </>
  );
}

/** 高亮角色 → 色值：plain 直用正文色（不另包 span)，comment 随文字三级灰，
 * 其余走 theme.syntax 色板（批 E) */
function codeRoleColor(theme: Theme, role: CodeTokenRole): string | undefined {
  switch (role) {
    case 'plain':
      return undefined;
    case 'comment':
      return theme.colors.textTertiary;
    default:
      return theme.syntax[role];
  }
}

/** 复制成功后对号图标驻留时长（ms） */
const COPIED_RESET_DELAY_MS = 1500;

interface CodeBlockProps {
  lang: string | null;
  text: string;
  sealed: boolean;
  tailGradient?: boolean;
}

/** 代码块：定型容器（亮度台阶底、无边框）+ 常驻顶栏（语言标签 + 14dp 复制按钮）
 * + 居中极浅发丝级分割线 + 双轴内滚（横滑不折行、纵向封顶 layout.codeBlockMaxHeight)
 * + 可长按选择。着色只对封口块（sealed)：尾块保持等宽原文，封口一次性着色 */
const CodeBlock = memo(function CodeBlock({
  lang,
  text,
  sealed,
  tailGradient,
}: CodeBlockProps) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyPress = usePressFade();

  // 组件卸载时安全清理定时器，杜绝内存泄漏
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  // 复制代码动作：触感反馈 + 写入剪贴板 + 状态机流转
  const handleCopy = useCallback(async () => {
    if (!text) return;
    haptics.selection();
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, COPIED_RESET_DELAY_MS);
    }
  }, [text]);

  const tokens = useMemo(
    () => (sealed ? tokenizeCode(lang, text) : null),
    [lang, text, sealed]
  );

  const displayLang = lang && lang.trim() ? lang.trim().toLowerCase() : 'code';

  return (
    <View
      testID="markdown-code-block"
      style={[
        codeBlockStyles.codeContainer,
        {
          backgroundColor: theme.colors.surfaceGrouped,
          borderRadius: theme.radius.control,
        },
      ]}
    >
      {/* 1. 顶栏区域：语言标签 + 复制按钮 */}
      <View style={codeBlockStyles.codeHeader}>
        <Text
          style={[
            theme.type.caption,
            codeBlockStyles.langLabel,
            {
              fontFamily: theme.type.mono.fontFamily,
              color: theme.colors.textTertiary,
            },
          ]}
        >
          {displayLang}
        </Text>
        <AnimatedPressable
          testID="markdown-code-copy-btn"
          accessibilityRole="button"
          accessibilityLabel={copied ? '已复制代码' : '复制代码'}
          hitSlop={{ top: 8, bottom: 8, left: 10, right: 10 }}
          onPress={handleCopy}
          onPressIn={copyPress.onPressIn}
          onPressOut={copyPress.onPressOut}
          style={[codeBlockStyles.copyBtn, copyPress.fadeStyle]}
        >
          <Icon
            name={copied ? 'check' : 'copy'}
            size={14}
            color={copied ? theme.colors.success : theme.colors.textTertiary}
          />
        </AnimatedPressable>
      </View>

      {/* 2. 居中极浅分割线：宽度 94%、发丝线、对齐设置页极浅质感 */}
      <View
        testID="markdown-code-divider"
        style={[
          codeBlockStyles.codeDivider,
          {
            backgroundColor: theme.dark
              ? 'rgba(255, 255, 255, 0.06)'
              : theme.colors.hairline,
          },
        ]}
      />

      {/* 3. 代码双轴内滚区域 */}
      <ScrollView
        style={[
          codeBlockStyles.codeScroll,
          { maxHeight: theme.layout.codeBlockMaxHeight },
        ]}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text
            selectable
            style={[theme.type.mono, { color: theme.colors.textPrimary }]}
          >
            {tokens ? (
              tokens.map((token, index) => {
                const color = codeRoleColor(theme, token.role);
                return color ? (
                  <Text key={index} style={{ color }}>
                    {token.text}
                  </Text>
                ) : (
                  token.text
                );
              })
            ) : tailGradient ? (
              <StreamingTailText
                text={text}
                streaming
                tailGradient
                style={[theme.type.mono, { color: theme.colors.textPrimary }]}
              />
            ) : (
              text
            )}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
});

const codeBlockStyles = StyleSheet.create({
  codeContainer: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 22,
    paddingBottom: 6,
  },
  langLabel: {
    textTransform: 'lowercase',
  },
  copyBtn: {
    padding: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeDivider: {
    height: StyleSheet.hairlineWidth,
    width: '94%',
    alignSelf: 'center',
  },
  codeScroll: {
    marginTop: 8,
  },
});

function ListBlock({
  ordered,
  start,
  items,
  ctx,
  cursorBox,
  sealed,
  tailGradient,
}: {
  ordered: boolean;
  start: number;
  items: MdListItem[];
  ctx: RenderCtx;
  cursorBox: CursorBox | null;
  sealed: boolean;
  tailGradient?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.xxs }}>
      {items.map((item, index) => {
        const isLastItem = index === items.length - 1;
        return (
          <View
            key={index}
            style={{ flexDirection: 'row', gap: theme.space.sm }}
          >
            <Text
              style={[
                theme.type.chat,
                {
                  color:
                    item.checked === null
                      ? theme.colors.textSecondary
                      : item.checked
                        ? theme.colors.success
                        : theme.colors.textTertiary,
                  minWidth: theme.space.lg,
                  textAlign:
                    item.checked === null && !ordered ? 'center' : 'right',
                },
              ]}
            >
              {item.checked !== null
                ? item.checked
                  ? '✓'
                  : '○'
                : ordered
                  ? `${start + index}.`
                  : '•'}
            </Text>
            <View style={{ flex: 1, gap: theme.space.xs }}>
              {item.blocks.map((child, childIndex) => {
                const isLastChild =
                  isLastItem && childIndex === item.blocks.length - 1;
                return (
                  <MarkdownBlockView
                    key={childIndex}
                    block={child}
                    ctx={ctx}
                    sealed={sealed}
                    tailGradient={isLastChild ? tailGradient : false}
                    cursorBox={isLastChild ? cursorBox : null}
                  />
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** 引用：左竖线（既有分隔色）+ 次级文字色，内层块递归同组件 */
function QuoteBlock({
  blocks,
  ctx,
  cursorBox,
  sealed,
  tailGradient,
}: {
  blocks: MdBlock[];
  ctx: RenderCtx;
  cursorBox: CursorBox | null;
  sealed: boolean;
  tailGradient?: boolean;
}) {
  const theme = useTheme();
  const quoteCtx: RenderCtx = {
    color: theme.colors.textSecondary,
    inBubble: ctx.inBubble,
    sources: ctx.sources,
    onCitationPress: ctx.onCitationPress,
    highlightedCitationIndex: ctx.highlightedCitationIndex,
  };
  return (
    <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
      <View
        style={{
          width: theme.space.xxs,
          backgroundColor: theme.colors.borderStrong,
          borderRadius: theme.radius.pill,
        }}
      />
      <View style={{ flex: 1, gap: theme.space.sm }}>
        {blocks.map((child, index) => {
          const isLastChild = index === blocks.length - 1;
          return (
            <MarkdownBlockView
              key={index}
              block={child}
              ctx={quoteCtx}
              sealed={sealed}
              tailGradient={isLastChild ? tailGradient : false}
              cursorBox={isLastChild ? cursorBox : null}
            />
          );
        })}
      </View>
    </View>
  );
}

function spansTextLength(spans: MdSpan[]): number {
  let len = 0;
  for (const span of spans) {
    if (span.type === 'text' || span.type === 'code') {
      len += span.text.length;
    } else if ('children' in span && Array.isArray(span.children)) {
      len += spansTextLength(span.children);
    }
  }
  return len;
}

/** 表格：横滑容器，等宽列对齐、表头次级底、微圆角外框与发丝线分隔 */
function TableBlock({
  block,
  ctx,
}: {
  block: Extract<MdBlock, { type: 'table' }>;
  ctx: RenderCtx;
}) {
  const theme = useTheme();

  // 计算每列自适应宽度：保证表头与所有数据行纵向严格对齐
  const numCols = Math.max(
    block.header.length,
    ...block.rows.map((r) => r.length)
  );

  const colWidths = useMemo(() => {
    const widths: number[] = [];
    for (let c = 0; c < numCols; c++) {
      let maxLen = block.header[c] ? spansTextLength(block.header[c]!) : 4;
      for (const row of block.rows) {
        if (row[c]) {
          maxLen = Math.max(maxLen, spansTextLength(row[c]!));
        }
      }
      // 动态列宽：根据内容长度计算，最小 72dp，最大 260dp
      const width = Math.max(72, Math.min(260, maxLen * 12 + 28));
      widths.push(width);
    }
    return widths;
  }, [block.header, block.rows, numCols]);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="markdown-table"
      style={{ marginVertical: 6 }}
    >
      <View
        style={{
          borderRadius: theme.radius.control,
          backgroundColor: theme.colors.surface,
          borderWidth: 1,
          borderColor: theme.colors.hairline,
          overflow: 'hidden',
        }}
      >
        {/* 表头 */}
        <View
          style={{
            flexDirection: 'row',
            backgroundColor: theme.colors.fillSubtle,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.hairline,
          }}
        >
          {block.header.map((cell, index) => (
            <View
              key={index}
              style={{
                width: colWidths[index] ?? 72,
                paddingHorizontal: 12,
                paddingVertical: 9,
                justifyContent: 'center',
                borderRightWidth:
                  index < colWidths.length - 1 ? StyleSheet.hairlineWidth : 0,
                borderRightColor: theme.colors.hairline,
              }}
            >
              <Text
                style={[
                  theme.type.footnote,
                  {
                    color: theme.colors.textPrimary,
                    fontWeight: '600',
                    textAlign: block.align[index] ?? 'left',
                  },
                ]}
              >
                <SpanNodes spans={cell} ctx={ctx} />
              </Text>
            </View>
          ))}
        </View>

        {/* 数据行 */}
        {block.rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={{
              flexDirection: 'row',
              backgroundColor:
                rowIndex % 2 === 1
                  ? theme.colors.fillSubtle
                  : theme.colors.surface,
              borderBottomWidth:
                rowIndex < block.rows.length - 1 ? StyleSheet.hairlineWidth : 0,
              borderBottomColor: theme.colors.hairline,
            }}
          >
            {row.map((cell, cellIndex) => (
              <View
                key={cellIndex}
                style={{
                  width: colWidths[cellIndex] ?? 72,
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                  justifyContent: 'center',
                  borderRightWidth:
                    cellIndex < colWidths.length - 1
                      ? StyleSheet.hairlineWidth
                      : 0,
                  borderRightColor: theme.colors.hairline,
                }}
              >
                <Text
                  style={[
                    theme.type.footnote,
                    {
                      color: ctx.color ?? theme.colors.textPrimary,
                      textAlign: block.align[cellIndex] ?? 'left',
                    },
                  ]}
                >
                  <SpanNodes spans={cell} ctx={ctx} />
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** 供时间线消息级 image 块复用：真实图片呈现（有来源时；几何走
 * MarkdownImage 的自然尺寸口径，FN-3 已废止恒定 4/3) */
export function TimelineImage({
  source,
  alt,
}: {
  source: string;
  alt: string;
}) {
  return (
    <MarkdownImage
      source={source}
      alt={alt}
      testID="timeline-image"
      placeholderTestID="timeline-image-placeholder"
    />
  );
}

/** 供时间线消息级 image 块复用：无可用来源时的占位行（不静默丢内容） */
export function TimelineImagePlaceholder({ alt }: { alt: string }) {
  const theme = useTheme();
  return (
    <View
      testID="timeline-image-placeholder"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.sm,
        padding: theme.space.md,
        borderRadius: theme.radius.control,
        backgroundColor: theme.colors.fillSubtle,
      }}
    >
      <Icon
        name="image"
        size={theme.size.iconSmall}
        color={theme.colors.textTertiary}
      />
      <AppText variant="footnote" color="textTertiary">
        {alt !== '' ? alt : '图片'}
      </AppText>
    </View>
  );
}

export default MarkdownText;
