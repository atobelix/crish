// 流式文本渲染组件（R2UX-05-02：preview 帧渐进渲染 + 终值替换 + 静态光标 + 渲染节流）：
// - text：数据面最新全文（preview 帧覆盖式）→ useStreamingText 节流后渐进渲染
//   （18ms 窗口合并 / 100ms 强制刷新 / 终值立即渲染——F3 §3.4.1 语义）；
// - streaming：流式期行尾渲染静态「▍」光标（R2UX §2.6-3 / 裁决 A3：静态光标不构成
//   逐字动画，M4 §8.4 禁止条款不冲突）；非流式期无光标；
// - 同 key 覆盖更新同节点（React 就地复用 Text 节点），无闪烁无跳动；
// - identity：条目稳定键（同 seq 覆盖保持不变；变化 = 新条目立即渲染）。
import { memo } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useStreamingText } from './useStreamingText';

/** 静态光标符号（R2UX §2.6-3 / 裁决 A3：允许静态光标，无位移无逐字推进） */
export const STREAMING_CURSOR = '▍';

export interface StreamingTextProps {
  /** 数据面最新全文（preview 帧覆盖式；流式期随预览帧更新） */
  text: string;
  /** 流式期标记（行尾静态「▍」光标 + 节流渐进渲染；false = 终值立即渲染） */
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
  /** 文本样式（透传 RN Text） */
  style?: StyleProp<TextStyle>;
  /** 单行截断（透传 RN Text） */
  numberOfLines?: number;
  /** 容器 testID */
  testID?: string;
}

/**
 * 流式文本（memo：同 key 覆盖更新时仅文本节点就地复用，无重挂载闪烁）。
 * 渲染结构：`<Text>{节流后文本}{流式期光标}</Text>`——光标恒定置于文本尾部。
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
  numberOfLines,
  testID,
}: StreamingTextProps) {
  const rendered = useStreamingText(identity, text, streaming, {
    mergeWindowMs,
    maxWaitMs,
  });

  return (
    <Text testID={testID} style={style} numberOfLines={numberOfLines}>
      {rendered}
      {streaming ? (
        <Text testID={cursorTestID} style={cursorStyle}>
          {` ${cursorSymbol}`}
        </Text>
      ) : null}
    </Text>
  );
});
