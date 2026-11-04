// markdown 正文渲染（MD2)：自有 AST → RN 组件树，样式全走 theme token
// （灰度分层、无边框滥用、代码块等宽、表格横滑；守卫禁止裸色值 / 数字圆角 /
// 数字字号，本文件一律经 useTheme 取档）。
// 口径（审计 §C)：
// - 静态（streaming=false）走 parseMarkdown 全量解析；流式走
//   prepareStreamingMarkdown：封口块最终形态按内容签名 memo、尾块分治呈现；
// - 超限降级：全文超 MARKDOWN_DEGRADE_THRESHOLD 时降级纯文本 + 可见标注
//   （不静默），原文仍可长按选择；
// - 链接一律经 openLink 统一出口（协议白名单在出口层），呈现层不裸调 openURL；
// - 代码块：封口后词法高亮（批 E；domain/pure/markdown/highlight，色走
//   theme.syntax)，流式尾块保持等宽原文；内容 selectable 长按选择（独立
//   复制按钮需 expo-clipboard，待裁决，不在本批假装实现）；
// - 公式 / Mermaid：封口后经本地 WebView 渲染（WebContentBlock，批 E)，
//   尾块 / 失败回落原文；整段展示公式在 AST 层识别（displayMath)，与正文
//   混排的行内公式保持原文（RN Text 内无块级渲染面，诚实口径）；
// - markdown 独立成段图：真加载（MarkdownImage，批 E；几何见 FN-3 口径），
//   与正文混排的行内图仍为文字标（同上，无块级面可嵌）。
import { memo, useMemo, type ReactNode } from 'react';
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

/** 超限降级线（字符数）：超过即纯文本 + 标注（审计 C.4，真机定标后写死） */
export const MARKDOWN_DEGRADE_THRESHOLD = 50_000;

export interface MarkdownTextProps {
  text: string;
  /** 流式期：走草稿分治（封口块定型 + 尾块分治）；false = 终态全量解析 */
  streaming?: boolean;
  /** 正文基础样式（缺省 theme.type.chat + textPrimary；气泡等场景由调用方透传既有 Text 样式） */
  baseStyle?: StyleProp<TextStyle>;
  /** 流式光标符号（由 StreamingText 透传；落在最后一个块的末尾） */
  cursorSymbol?: string;
  cursorTestID?: string;
  cursorStyle?: StyleProp<TextStyle>;
  testID?: string;
}

/** 渲染上下文：正文色与气泡标记（气泡内行内代码底色需换档，见 span 渲染） */
interface RenderCtx {
  color: ColorValue;
  inBubble: boolean;
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
  baseStyle,
  cursorSymbol,
  cursorTestID,
  cursorStyle,
  testID,
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
        <Text
          selectable
          style={[theme.type.chat, { color: ctx.color }, flatBase]}
        >
          {text}
        </Text>
        {cursorBox.node}
      </View>
    );
  }

  const list = blocks ?? [];
  const lastBlock = list[list.length - 1];
  const cursorInline = !!lastBlock && blockConsumesCursor(lastBlock);
  return (
    <View testID={testID} style={{ gap: theme.space.md }}>
      {list.map((block, index) => (
        <MarkdownBlockView
          key={index}
          block={block}
          ctx={ctx}
          sealed={index < sealedCount}
          cursorBox={
            index === list.length - 1 && cursorInline ? cursorBox : null
          }
        />
      ))}
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
  }: {
    block: MdBlock;
    ctx: RenderCtx;
    cursorBox: CursorBox | null;
    sealed: boolean;
  }) {
    return (
      <BlockNode
        block={block}
        ctx={ctx}
        cursorBox={cursorBox}
        sealed={sealed}
      />
    );
  },
  (prev, next) =>
    blockSignature(prev.block) === blockSignature(next.block) &&
    prev.ctx.color === next.ctx.color &&
    prev.ctx.inBubble === next.ctx.inBubble &&
    prev.sealed === next.sealed &&
    (prev.cursorBox?.node ?? null) === (next.cursorBox?.node ?? null)
);

function BlockNode({
  block,
  ctx,
  cursorBox,
  sealed,
}: {
  block: MdBlock;
  ctx: RenderCtx;
  cursorBox: CursorBox | null;
  sealed: boolean;
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
          <SpanNodes spans={block.spans} ctx={ctx} />
          {consumeCursor(cursorBox)}
        </Text>
      );
    }
    case 'heading':
      return (
        <Text style={[headingStyle(theme, block.level), { color: ctx.color }]}>
          <SpanNodes spans={block.spans} ctx={ctx} />
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
      return <CodeBlock lang={block.lang} text={block.text} sealed={sealed} />;
    case 'list':
      return (
        <ListBlock
          ordered={block.ordered}
          start={block.start}
          items={block.items}
          ctx={ctx}
          cursorBox={cursorBox}
          sealed={sealed}
        />
      );
    case 'quote':
      return (
        <QuoteBlock
          blocks={block.blocks}
          ctx={ctx}
          cursorBox={cursorBox}
          sealed={sealed}
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
function SpanNodes({ spans, ctx }: { spans: MdSpan[]; ctx: RenderCtx }) {
  const theme = useTheme();
  return (
    <>
      {spans.map((span, index) => {
        switch (span.type) {
          case 'text':
            // 纯文本直接以字符串作子节点：少建节点，文本查询口径与单 Text 一致
            return span.text;
          case 'break':
            return '\n';
          case 'strong':
            return (
              <Text key={index} style={{ fontWeight: '700' }}>
                <SpanNodes spans={span.children} ctx={ctx} />
              </Text>
            );
          case 'em':
            return (
              <Text key={index} style={{ fontStyle: 'italic' }}>
                <SpanNodes spans={span.children} ctx={ctx} />
              </Text>
            );
          case 'del':
            return (
              <Text key={index} style={{ textDecorationLine: 'line-through' }}>
                <SpanNodes spans={span.children} ctx={ctx} />
              </Text>
            );
          case 'code':
            return (
              <Text
                key={index}
                style={{
                  fontFamily: theme.type.mono.fontFamily,
                  backgroundColor: ctx.inBubble
                    ? theme.colors.fillPressed
                    : theme.colors.surfaceGrouped,
                }}
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
                <SpanNodes spans={span.children} ctx={ctx} />
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

/** 代码块：定型容器（亮度台阶底、无边框）+ 头栏（语言名，无复制钮——移动
 * 无复制钮裁决）+ 双轴内滚（横滑不折行、纵向封顶 layout.codeBlockMaxHeight)
 * + 可长按选择。着色只对封口块（sealed)：尾块保持等宽原文，封口一次性着色 */
function CodeBlock({
  lang,
  text,
  sealed,
}: {
  lang: string | null;
  text: string;
  sealed: boolean;
}) {
  const theme = useTheme();
  const tokens = useMemo(
    () => (sealed ? tokenizeCode(lang, text) : null),
    [lang, text, sealed]
  );
  return (
    <View
      testID="markdown-code-block"
      style={{
        backgroundColor: theme.colors.surfaceGrouped,
        borderRadius: theme.radius.control,
        padding: theme.space.md,
        gap: theme.space.xs,
      }}
    >
      {lang ? (
        <View style={{ flexDirection: 'row' }}>
          <Text
            style={[
              theme.type.caption,
              {
                fontFamily: theme.type.mono.fontFamily,
                color: theme.colors.textTertiary,
              },
            ]}
          >
            {lang}
          </Text>
        </View>
      ) : null}
      <ScrollView
        style={{ maxHeight: theme.layout.codeBlockMaxHeight }}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text
            selectable
            style={[theme.type.mono, { color: theme.colors.textPrimary }]}
          >
            {tokens
              ? tokens.map((token, index) => {
                  const color = codeRoleColor(theme, token.role);
                  return color ? (
                    <Text key={index} style={{ color }}>
                      {token.text}
                    </Text>
                  ) : (
                    token.text
                  );
                })
              : text}
          </Text>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function ListBlock({
  ordered,
  start,
  items,
  ctx,
  cursorBox,
  sealed,
}: {
  ordered: boolean;
  start: number;
  items: MdListItem[];
  ctx: RenderCtx;
  cursorBox: CursorBox | null;
  sealed: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.xxs }}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
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
              {item.blocks.map((child, childIndex) => (
                <MarkdownBlockView
                  key={childIndex}
                  block={child}
                  ctx={ctx}
                  sealed={sealed}
                  cursorBox={
                    isLast && childIndex === item.blocks.length - 1
                      ? cursorBox
                      : null
                  }
                />
              ))}
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
}: {
  blocks: MdBlock[];
  ctx: RenderCtx;
  cursorBox: CursorBox | null;
  sealed: boolean;
}) {
  const theme = useTheme();
  const quoteCtx: RenderCtx = {
    color: theme.colors.textSecondary,
    inBubble: ctx.inBubble,
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
        {blocks.map((child, index) => (
          <MarkdownBlockView
            key={index}
            block={child}
            ctx={quoteCtx}
            sealed={sealed}
            cursorBox={index === blocks.length - 1 ? cursorBox : null}
          />
        ))}
      </View>
    </View>
  );
}

/** 表格：横滑容器，表头次级底、行间分隔、单元格不折行 */
function TableBlock({
  block,
  ctx,
}: {
  block: Extract<MdBlock, { type: 'table' }>;
  ctx: RenderCtx;
}) {
  const theme = useTheme();
  const cellStyle = (align: 'left' | 'center' | 'right' | null) => ({
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.xs,
    textAlign: align ?? 'left',
  });
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="markdown-table"
    >
      <View
        style={{
          borderRadius: theme.radius.control,
          backgroundColor: theme.colors.surfaceGrouped,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            backgroundColor: theme.colors.fillSubtle,
          }}
        >
          {block.header.map((cell, index) => (
            <Text
              key={index}
              numberOfLines={1}
              style={[
                theme.type.chat,
                { color: ctx.color, fontWeight: '700' },
                cellStyle(block.align[index] ?? null),
              ]}
            >
              <SpanNodes spans={cell} ctx={ctx} />
            </Text>
          ))}
        </View>
        {block.rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={{
              flexDirection: 'row',
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: theme.colors.hairline,
            }}
          >
            {row.map((cell, cellIndex) => (
              <Text
                key={cellIndex}
                numberOfLines={1}
                style={[
                  theme.type.chat,
                  { color: ctx.color },
                  cellStyle(block.align[cellIndex] ?? null),
                ]}
              >
                <SpanNodes spans={cell} ctx={ctx} />
              </Text>
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
