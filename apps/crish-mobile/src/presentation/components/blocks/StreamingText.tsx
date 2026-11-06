// 流式文本渲染组件（呈现节拍：useStreamingText 单一平准路径；渲染终点：
// MarkdownText 结构化呈现，封口块最终形态 + 尾块分治，MD2 起）：
// - text：数据面最新全文（preview 帧覆盖式）→ useStreamingText 经平准游标
//   匀速揭示（缓冲池 + 惯性加减速，基线 32 字/秒、封顶 70 字/秒），不再
//   整段替换跳变；呈现帧同时携带尾部字素的出生登记（同一游标产出）；
// - 末端时间渐显（2026-11-05 用户题 10 裁决，对齐参考实现 D:\download\ai.html
//   的时间维度口径并按 Android 特性落地）：刚写出的字素以透明度 0.22 起、
//   按幂曲线 560ms 内升至 1，透明度经 color 的 alpha 通道施加（非节点
//   opacity)，零阴影零模糊零位移；缺省开启（tailFade prop)；
// - 追赶态：上游流结束（streaming=false）后平准器尚在泄洪收敛的窗口内，
//   呈现文本仍短于目标全文——此窗口内对 MarkdownText 维持流式分治与渐显
//   （effectiveStreaming)，收敛完成（呈现文本 = 全文）才切终态全量解析，
//   封口块的最终形态语义不被泄洪拖慢污染；
// - 兼容性：当明确关闭渐显（tailFade=false）或外部显式注入 cursorSymbol /
//   cursorTestID 时回退传统静态光标「▍」（置于文本尾部，流式期含追赶期）；
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
  /** 流式期标记（平准揭示 + 末端渐显；false = 终态：泄洪收敛后全量解析） */
  streaming: boolean;
  /** 条目稳定键（同 seq 覆盖保持不变；变化 = 新条目立即种子化） */
  identity: string;
  /** 是否开启末端时间渐显（缺省 true，2026-11-05 用户题 10 裁决） */
  tailFade?: boolean;
  /** 传统静态光标符号（仅在 tailFade=false 或显式要求时回退渲染） */
  cursorSymbol?: string;
  /** 光标 testID（组件测试锚点） */
  cursorTestID?: string;
  /** 光标样式（如主题色弱化；缺省跟随文本样式） */
  cursorStyle?: StyleProp<TextStyle>;
  /** 正文基础样式（透传 MarkdownText 的 baseStyle) */
  style?: StyleProp<TextStyle>;
  /** 点击引证微标回调（透传 MarkdownText) */
  onCitationPress?: (index: number) => void;
  /** 容器 testID */
  testID?: string;
}

/**
 * 流式文本（memo：同 key 覆盖更新时仅内容就地更新，无重挂载闪烁）。
 * 节拍由 useStreamingText 的平准游标承担，结构呈现由 MarkdownText 承担。
 */
export const StreamingText = memo(function StreamingText({
  text,
  streaming,
  identity,
  tailFade = true,
  cursorSymbol,
  cursorTestID,
  cursorStyle,
  style,
  onCitationPress,
  testID,
}: StreamingTextProps) {
  const frame = useStreamingText(identity, text, streaming);

  // 追赶态：呈现文本尚未收敛到目标全文（平准揭示中 / 终态泄洪中）
  const catchingUp = frame.text !== text;
  const effectiveStreaming = streaming || catchingUp;

  // 传统机械光标回退逻辑：
  // 仅在明确禁用渐显 (tailFade=false) 或外部显式指定光标 (cursorSymbol / cursorTestID 注入) 时启用
  const showFallbackCursor =
    !tailFade || cursorSymbol !== undefined || cursorTestID !== undefined;
  const effectiveCursorSymbol =
    showFallbackCursor && effectiveStreaming
      ? (cursorSymbol ?? STREAMING_CURSOR)
      : undefined;

  return (
    <MarkdownText
      text={frame.text}
      streaming={effectiveStreaming}
      tailFade={tailFade && effectiveStreaming ? frame.tailFade : null}
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
