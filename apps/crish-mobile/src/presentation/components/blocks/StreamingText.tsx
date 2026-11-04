// 流式文本渲染组件（R2UX-05-02 节流语义 + MD2 渲染终点）：
// - text：数据面最新全文（preview 帧覆盖式）→ useStreamingText 节流后渐进渲染
//   （18ms 窗口合并 / 100ms 强制刷新 / 终值立即渲染——F3 §3.4.1 语义不变）；
// - 渲染终点（MD2 起）：节流后的文本喂给 MarkdownText 做结构化呈现（封口块
//   最终形态 + 尾块分治），不再单 Text 直出 markdown 原文；流式期静态光标
//   「▍」经 MarkdownText 落在最后一个块的末尾；
// - 同 identity 就地更新（React 复用节点），无闪烁无跳动。
import { memo } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useStreamingText } from './useStreamingText';
import { MarkdownText } from './MarkdownText';

/** 静态光标符号（R2UX §2.6-3 / 裁决 A3：允许静态光标，无位移无逐字推进） */
export const STREAMING_CURSOR = '▍';

export interface StreamingTextProps {
  /** 数据面最新全文（preview 帧覆盖式；流式期随预览帧更新） */
  text: string;
  /** 流式期标记（尾部静态「▍」光标 + 节流渐进渲染；false = 终值立即渲染） */
  streaming: boolean;
  /** 条目稳定键（同 seq 覆盖保持不变；变化 = 新条目立即渲染） */
  identity: string;
  /** 静态光标符号（缺省「▍」；前置空格分隔文本与光标） */
  cursorSymbol?: string;
  /** 光标 testID（组件测试锚点） */
  cursorTestID?: string;
  /** 光标样式（如主题色弱化；缺省跟随文本样式） */
  cursorStyle?: StyleProp<TextStyle>;
  /** 合并窗口（ms，缺省 18；测试注入） */
  mergeWindowMs?: number;
  /** 强制刷新边界（ms，缺省 100；测试注入） */
  maxWaitMs?: number;
  /** 正文基础样式（透传 MarkdownText 的 baseStyle) */
  style?: StyleProp<TextStyle>;
  /** 容器 testID */
  testID?: string;
}

/**
 * 流式文本（memo：同 key 覆盖更新时仅内容就地更新，无重挂载闪烁）。
 * 节流由 useStreamingText 承担，结构呈现由 MarkdownText 承担，光标恒定
 * 置于最后一个块的末尾。
 */
export const StreamingText = memo(function StreamingText({
  text,
  streaming,
  identity,
  cursorSymbol = STREAMING_CURSOR,
  cursorTestID,
  cursorStyle,
  mergeWindowMs,
  maxWaitMs,
  style,
  testID,
}: StreamingTextProps) {
  const rendered = useStreamingText(identity, text, streaming, {
    mergeWindowMs,
    maxWaitMs,
  });

  return (
    <MarkdownText
      text={rendered}
      streaming={streaming}
      baseStyle={style}
      cursorSymbol={streaming ? cursorSymbol : undefined}
      cursorTestID={cursorTestID}
      cursorStyle={cursorStyle}
      testID={testID}
    />
  );
});
