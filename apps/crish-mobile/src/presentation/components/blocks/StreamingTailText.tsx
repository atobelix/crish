// apps/crish-mobile/src/presentation/components/blocks/StreamingTailText.tsx
// 流式文本末端行内字素梯度分段呈现组件（IGSW）
// 核心职责：
// 1. 纯内联原生嵌套 <Text>，零多余原生 View 容器，完全交由操作系统排版引擎（CoreText / StaticLayout）自然折行；
// 2. 流式活跃期（streaming=true 且 tailGradient=true）：稳定正文保持 100% 不透明，末端呈现 5 阶半透明衰减梯级（alpha 0.88 -> 0.16）+ 微发光阴影；
// 3. 终态收口期（streaming=false 或 tailGradient=false）：完全销毁梯级节点，退化为单一 100% 静态纯净文本；
// 4. 节点数量严格 O(1) 恒定，完全保持 60/120 FPS 丝滑流动。

import { memo } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  partitionTailGradient,
  type TailGradientConfig,
} from '@/domain/pure/markdown/tailGradient';

export interface StreamingTailTextProps {
  /** 完整文本内容 */
  text: string;
  /** 是否处于流式状态 (false = 终态纯文本呈现) */
  streaming?: boolean;
  /** 是否启用模糊渐变尾端 (缺省 true) */
  tailGradient?: boolean;
  /** 渐变配置 */
  gradientConfig?: TailGradientConfig;
  /** 基础文字样式 */
  style?: StyleProp<TextStyle>;
  /** 是否允许文本选择 */
  selectable?: boolean;
  /** 测试标识 */
  testID?: string;
}

/**
 * 带有末端模糊渐显特性的高性能文本呈现组件。
 * 纯内联原生嵌套，零外部原生 View 依赖，完全保持系统折行与 120fps 渲染能力。
 */
export const StreamingTailText = memo(function StreamingTailText({
  text,
  streaming = false,
  tailGradient = true,
  gradientConfig,
  style,
  selectable,
  testID,
}: StreamingTailTextProps) {
  const theme = useTheme();

  // 若不在流式期或显式关闭渐显，直接渲染单一 Text
  if (!streaming || !tailGradient) {
    return (
      <Text testID={testID} style={style} selectable={selectable}>
        {text}
      </Text>
    );
  }

  const { solidPrefix, tiers } = partitionTailGradient(
    text,
    true,
    gradientConfig
  );

  // 若文本过短无需分阶，直接渲染单一文本
  if (tiers.length === 0) {
    return (
      <Text testID={testID} style={style} selectable={selectable}>
        {solidPrefix}
      </Text>
    );
  }

  const flatStyle = style ? StyleSheet.flatten(style) : undefined;
  const shadowColor = flatStyle?.color ?? theme.colors.textPrimary;

  // 阴影发光参数 (与文字颜色对齐的微扩散景深光晕，模拟移动端高 PPI 次像素光学弥散)
  const glowStyle: TextStyle = {
    textShadowColor: shadowColor,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 2.5,
  };

  return (
    <Text testID={testID} style={style} selectable={selectable}>
      {solidPrefix}
      {tiers.map((tier, index) => (
        <Text
          key={index}
          testID={`${testID ?? 'tail'}-tier-${index}`}
          style={[
            { opacity: tier.opacity },
            tier.hasGlow ? glowStyle : undefined,
          ]}
        >
          {tier.text}
        </Text>
      ))}
    </Text>
  );
});

export default StreamingTailText;
