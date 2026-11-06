// apps/crish-mobile/src/presentation/components/blocks/StreamingTailText.tsx
// 流式文本末端时间渐显呈现组件（波 6 达标步，2026-11-05 用户题 10 裁决）
// 核心职责：
// 1. 纯内联原生嵌套 <Text>，零多余原生 View 容器，完全交由操作系统排版引擎
//    （CoreText / StaticLayout）自然折行；
// 2. 流式活跃期（streaming=true 且 tailFade 帧在场）：按 temporalFade 模型把
//    文本切为稳定前缀（原色纯文本）+ 尾部渐显分段——每段透明度由其字素的
//    birthTime 与帧时刻经幂曲线换算，是时间维度的渐显（刚写出的字淡、随即
//    在 560ms 内变实），不存在按位置钉死的半透明尾巴；
// 3. 透明度经 color 的 alpha 通道施加（withAlpha 派生 rgba)，不使用 Text
//    节点 opacity：Android 单次光栅化、边缘干净（节点 opacity 走离屏合成、
//    边缘灰阶失真，已被方案否决）；零阴影、零模糊、零位移（守卫钉版）；
// 4. 终态（streaming=false 或无渐显帧）：完全销毁分段节点，退化为单一
//    100% 静态纯净文本；分段数量由渐显窗口与量化步长封顶，恒为 O(1) 量级。

import { memo } from 'react';
import {
  StyleSheet,
  Text,
  type ColorValue,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import {
  partitionTemporalFade,
  withAlpha,
  type TailFadeFrame,
} from '@/domain/pure/markdown/temporalFade';

export interface StreamingTailTextProps {
  /** 完整文本内容（当前呈现帧的尾段文本） */
  text: string;
  /** 是否处于流式状态 (false = 终态纯文本呈现） */
  streaming?: boolean;
  /** 时间渐显帧（出生登记 + 帧时刻）；null / 缺省 = 不渐显 */
  tailFade?: TailFadeFrame | null;
  /**
   * 正文基色：渐显分段由其 alpha 通道派生。提供 tailFade 时应同时传入
   * （调用方均在主题色上下文中，取正文色 / 链接色 / 等宽色等实际生效色）。
   * 非字符串型 ColorValue 无法派生 alpha，该段按原色渲染（本 App 主题色
   * 均为 hex 字符串，此路径仅为类型完备性兜底）。
   */
  color?: ColorValue;
  /** 基础文字样式 */
  style?: StyleProp<TextStyle>;
  /** 是否允许文本选择 */
  selectable?: boolean;
  /** 测试标识 */
  testID?: string;
}

/**
 * 带有末端时间渐显的文本呈现组件。
 * 出生登记由平准游标在揭示时产生、随呈现帧透传至此；本组件只做纯换算
 * 与渲染，不自带任何节拍。
 */
export const StreamingTailText = memo(function StreamingTailText({
  text,
  streaming = false,
  tailFade,
  color,
  style,
  selectable,
  testID,
}: StreamingTailTextProps) {
  // 不在流式期或无渐显帧：单一纯文本
  if (!streaming || !tailFade) {
    return (
      <Text testID={testID} style={style} selectable={selectable}>
        {text}
      </Text>
    );
  }

  const { solidPrefix, segments } = partitionTemporalFade(
    text,
    tailFade.births,
    tailFade.atTime
  );

  // 全部字素已固化（渐显走完 / 无新鲜出生登记）：单一纯文本
  if (segments.length === 0) {
    return (
      <Text testID={testID} style={style} selectable={selectable}>
        {text}
      </Text>
    );
  }

  // 基色解析：显式 color 优先，其次 style 内的 color；皆非字符串则分段
  // 按原色渲染（见 props 注释的类型完备性兜底）
  const flatColor = StyleSheet.flatten(style)?.color;
  const baseColor =
    typeof color === 'string'
      ? color
      : typeof flatColor === 'string'
        ? flatColor
        : undefined;

  return (
    <Text testID={testID} style={style} selectable={selectable}>
      {solidPrefix}
      {segments.map((segment, index) => (
        <Text
          key={index}
          testID={`${testID ?? 'tail'}-fade-${index}`}
          style={{
            color:
              baseColor !== undefined
                ? withAlpha(baseColor, segment.alpha)
                : color,
          }}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
});

export default StreamingTailText;
