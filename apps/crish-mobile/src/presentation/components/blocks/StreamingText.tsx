// 流式文本渲染组件（R2UX-05-02 节流语义 + MD2 渲染终点）：
// - text：数据面最新全文（preview 帧覆盖式）→ useStreamingText 节流后渐进渲染
//   （18ms 窗口合并 / 100ms 强制刷新 / 终值立即渲染——F3 §3.4.1 语义不变）；
// - 渲染终点（MD2 起）：节流后的文本喂给 MarkdownText 做结构化呈现（封口块
//   最终形态 + 尾块分治），不再单 Text 直出 markdown 原文；
// - 末端流淌质感（方案 25）：默认启用 tailGradient（行内字素梯度分段窗口模型 IGSW），
//   末端 5 阶半透明衰减渐显（alpha 0.88 -> 0.16）+ 微发光阴影，彻底淘汰粗暴跳闪光标；
// - 兼容性：当明确关闭渐显（tailGradient=false）或外部显式注入 cursorSymbol/cursorTestID
//   时平滑回退传统静态光标「▍」；
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
  /** 流式期标记（尾部微光流淌渐显 + 节流渐进渲染；false = 终值立即渲染） */
  streaming: boolean;
  /** 条目稳定键（同 seq 覆盖保持不变；变化 = 新条目立即渲染） */
  identity: string;
  /** 是否开启末端模糊渐显 (缺省 true，对齐 2026-11-04 用户裁决) */
  tailGradient?: boolean;
  /** 传统静态光标符号（仅在 tailGradient=false 或显式要求时回退渲染） */
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
  /** 点击引证微标回调 (透传 MarkdownText) */
  onCitationPress?: (index: number) => void;
  /** 容器 testID */
  testID?: string;
}

/**
 * 流式文本（memo：同 key 覆盖更新时仅内容就地更新，无重挂载闪烁）。
 * 节流由 useStreamingText 承担，结构呈现由 MarkdownText 承担。
 * 开启 tailGradient 时，末端呈现 5 阶半透明流淌微光，停用生硬跳闪光标。
 */
export const StreamingText = memo(function StreamingText({
  text,
  streaming,
  identity,
  tailGradient = true,
  cursorSymbol,
  cursorTestID,
  cursorStyle,
  mergeWindowMs,
  maxWaitMs,
  style,
  onCitationPress,
  testID,
}: StreamingTextProps) {
  const rendered = useStreamingText(identity, text, streaming, {
    mergeWindowMs,
    maxWaitMs,
  });

  // 传统机械光标淘汰逻辑：
  // 仅在明确禁用渐显 (tailGradient=false) 或外部显式指定光标 (cursorSymbol / cursorTestID 注入) 时回退
  const showFallbackCursor =
    !tailGradient || cursorSymbol !== undefined || cursorTestID !== undefined;
  const effectiveCursorSymbol =
    showFallbackCursor && streaming
      ? (cursorSymbol ?? STREAMING_CURSOR)
      : undefined;

  return (
    <MarkdownText
      text={rendered}
      streaming={streaming}
      tailGradient={tailGradient}
      baseStyle={style}
      cursorSymbol={effectiveCursorSymbol}
      cursorTestID={cursorTestID}
      cursorStyle={cursorStyle}
      onCitationPress={onCitationPress}
      testID={testID}
    />
  );
});

export default StreamingText;
