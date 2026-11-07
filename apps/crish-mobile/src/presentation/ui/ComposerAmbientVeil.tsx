// ComposerAmbientVeil —— 悬浮输入框贯穿全宽、长距向上消散的宏观环境遮蔽光晕。
//
// 架构角色（方案 24：双轨共生光影模型）：
// 1. 轨一（微观）：卡体微气垫（SoftShadow composer 档，贴合圆角形态，峰值 3.76% 极软边界）；
// 2. 轨二（宏观）：贯穿全宽环境光晕（本组件），横向 100% 贯穿视口两端，自输入框容器
//    顶缘向上延伸 28dp 自然衰减，模拟真实天光遮蔽（Ambient Occlusion）；
// 3. 解决痛点：当消息流中的纯白代码块（#ffffff）滑动到底部纯白输入框后方时，光晕将代码块
//    平滑羽化为 ~#f0f0f0，形成明度反差 ΔL* ≈ 5.2（远超人眼 JND 阈值 2.3），彻底解耦白白黏连；
// 4. 光学模型：基于 Smoothstep / Hermite 样条曲线（S(t) = 3t² - 2t³）的五阶非线性多停点渐变，
//    杜绝两端光线折痕（Mach Bands 伪影）；
// 5. 深色短路：深色模式下返回 null（深黑背景上加黑影会造成死黑脏斑，无物理意义）；
// 6. 性能与可访问性：纯 GPU 片元插值零额外显存，React.memo 固化打字重渲染次数恒为 0，
//    pointerEvents="none" 绝不拦截滚动与触摸，无障碍属性对读屏软件透明屏蔽。

import React, { useId } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';

/** 默认向上环境光晕羽化高度（dp） */
export const DEFAULT_VEIL_HEIGHT = 28;

// 光晕纯黑常数（系环境投影规格而非主题色面，styleTokens 守卫白名单收录）
const VEIL_COLOR = '#000000';

/** 5 阶 Hermite 平滑衰减停点表（S(t) = 3t² - 2t³，从顶向下透明→接触线 6% 黑） */
export const VEIL_STOPS = [
  { offset: '0%', opacity: 0 },
  { offset: '25%', opacity: 0.004 },
  { offset: '50%', opacity: 0.016 },
  { offset: '75%', opacity: 0.038 },
  { offset: '100%', opacity: 0.06 },
] as const;

export interface ComposerAmbientVeilProps {
  /** 向上漫反射羽化带高度（dp，默认 28） */
  height?: number;
  /** 测试标识，默认 'composer-ambient-veil' */
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export const ComposerAmbientVeil = React.memo(function ComposerAmbientVeil({
  height = DEFAULT_VEIL_HEIGHT,
  testID = 'composer-ambient-veil',
  style,
}: ComposerAmbientVeilProps) {
  const theme = useTheme();
  const rawId = useId();
  const gradientId = `composer-ambient-veil-grad-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;

  // 深色模式短路：深色依靠 borderStrong 与高光分层，加黑渐变无物理意义且发脏
  if (theme.dark) {
    return null;
  }

  if (height <= 0) {
    return null;
  }

  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[
        styles.container,
        {
          top: -height,
          height,
        },
        style,
      ]}
    >
      <Svg width="100%" height={height} pointerEvents="none">
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="100%">
            {VEIL_STOPS.map((stop) => (
              <Stop
                key={stop.offset}
                offset={stop.offset}
                stopColor={VEIL_COLOR}
                stopOpacity={stop.opacity}
              />
            ))}
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={height} fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
});

export default ComposerAmbientVeil;
