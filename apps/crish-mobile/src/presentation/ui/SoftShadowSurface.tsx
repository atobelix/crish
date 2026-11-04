// 容器级 SVG 软阴影面（SoftShadow 的自测量泛化，2026-11-02 容器外阴影批）：
// 服务「浮层容器」——下拉菜单 / 居中弹窗 / 底部 Sheet / 审批浮卡 / 悬浮胶囊；
// 按钮与胶囊小面继续走 SoftShadow。
// 预设规格：几何（dy / σ）逐条对齐原型浮层阴影（reference/crish-mobile-drawer，
// CSS blur=2σ 换算），α 沿革：2026-11-02 晚用户硬裁决曾立「全档恒按钮极软
// 规格（近 α0.008 / 远 α0.012）」为上限；button 预设在 2026-11-03 经
// 原型极软与四周均匀校准，与 SoftShadow button 档同步对齐（近 dy0 σ3 α0.008 +
// 远 dy2 σ8 α0.012，pad 32），解决四周不均与发暗脏感；
// 余档（menu/dialog/sheetUp/floatCard/toast/banner/voiceCard）按用户
// 「其余表面不动」恒 0.008 / 0.012 不变；消息输入框卡的档在 SoftShadow
// 的 composer 档，不在本文件（详见 PRESETS 上方规格表；noShadow 守卫
// 按档钉版）。原生阴影纪律与 SoftShadow 一致：仅 Android + 浅色主题渲染
// 阴影；深色 / iOS 只渲染填充面（区分走 surfaceRaised 亮度台阶 / 玻璃，
// 与收编定案同源）。
// 结构（2026-11-03 二次校准，与 SoftShadow 同步）：每层投影在合并前以
// 源形状 alpha 做 operator="out" 内渗切除——投影恒只存在于轮廓之外、
// 内部零渗（半透填充面下亦然），机制见 SoftShadow 文件头结构沿革。
// 结构：外层 View 承载布局 / 变换（宿主可外包 Animated.View 做入场或位移，
// 本层不裁剪、不设 overflow）；内层单一填充节点（圆角 + overflow hidden 裁剪
// 内容）——填充单点绘制（色由宿主给），内容经 children 注入。
// 尺寸自测量（onLayout）：首帧无阴影、布局回包后补上（浮层为静态展示场景，
// 一帧空窗无感）；定尺寸宿主可传 width/height 跳过空窗。SVG 滤镜 id 按实例
// 唯一化（useId，同 SoftShadow 收口批防线）。滤镜区域用 userSpaceOnUse 全画布：
// 大 σ 档（dialog σ24）的出血远超元素包围盒百分比区，百分比区会在小元素上裁影。
import { useCallback, useId, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import Svg, {
  Defs,
  FeComposite,
  FeFlood,
  FeGaussianBlur,
  FeMerge,
  FeMergeNode,
  FeOffset,
  Filter,
  Rect as SvgRect,
} from 'react-native-svg';
import { useTheme } from '@/adapters/platform/theme';

/** 单层投影规格（dy 可负 = 上向；sigma = CSS blur / 2；alpha 为逐档 sanctioned 值） */
interface ShadowLayer {
  readonly dy: number;
  readonly sigma: number;
  readonly alpha: number;
}

interface ShadowSpec {
  /** 画布四周出血 = 3σmax + |dy|max + 2，向上取整 */
  readonly pad: number;
  readonly layers: readonly ShadowLayer[];
}

// —— 浮层阴影规格表（几何源：reference/crish-mobile-drawer/css）——
// α 沿革：2026-11-02 晚裁决曾定每档恒两层（近 α0.008 / 远 α0.012）；
// button 档 2026-11-03 经历波 3 上调后由二次校准定档（与 SoftShadow
// button 档同值：几何回原型、近 α0.013 / 远 α0.019，合成核心 ≈0.032），
// 余档不变。各档几何（CSS 等值）：
// button:    --btn-shadow 本档          近 0  2px  6px + 远 0  6px 16px
// menu:      dropdown-menu 几何         近 0  4px 12px + 远 0 10px 30px
// dialog:    modal-dialog-card 几何     近 0  8px 20px + 远 0 20px 48px
// sheetUp:   sheet-panel 几何（上向）    近 0 -4px 14px + 远 0 -10px 32px
// floatCard: 审批浮卡几何               近 0  4px 14px + 远 0 10px 36px
// toast:     toast-pill 几何            近 0  2px  6px + 远 0  4px 12px
// banner:    按钮档放大半径（用户裁决）  近 0  2px 10px + 远 0  6px 24px
// voiceCard: voice-recording-card 几何  近 0  5px 14px + 远 0 12px 32px
// 原型逐面 α（menu/sheetUp/floatCard/voiceCard 0.08、dialog 0.16、toast
// 0.15、banner 0.05）已被裁决覆盖作废，不得回潮（noShadow 守卫钉版）。
// 用户裁定（2026-11-02）：全 App 无「无阴影的墨色胶囊」例外——所有阴影都是
// 软阴影；墨色面（toast）同样经本组件走软阴影。
const PRESETS = {
  button: {
    pad: 32,
    layers: [
      { dy: 0, sigma: 3, alpha: 0.008 },
      { dy: 0, sigma: 8, alpha: 0.012 },
    ],
  },
  menu: {
    pad: 57,
    layers: [
      { dy: 4, sigma: 6, alpha: 0.008 },
      { dy: 10, sigma: 15, alpha: 0.012 },
    ],
  },
  dialog: {
    pad: 94,
    layers: [
      { dy: 8, sigma: 10, alpha: 0.008 },
      { dy: 20, sigma: 24, alpha: 0.012 },
    ],
  },
  sheetUp: {
    pad: 60,
    layers: [
      { dy: -4, sigma: 7, alpha: 0.008 },
      { dy: -10, sigma: 16, alpha: 0.012 },
    ],
  },
  floatCard: {
    pad: 66,
    layers: [
      { dy: 4, sigma: 7, alpha: 0.008 },
      { dy: 10, sigma: 18, alpha: 0.012 },
    ],
  },
  toast: {
    pad: 24,
    layers: [
      { dy: 2, sigma: 3, alpha: 0.008 },
      { dy: 4, sigma: 6, alpha: 0.012 },
    ],
  },
  banner: {
    pad: 44,
    layers: [
      { dy: 2, sigma: 5, alpha: 0.008 },
      { dy: 6, sigma: 12, alpha: 0.012 },
    ],
  },
  voiceCard: {
    pad: 62,
    layers: [
      { dy: 5, sigma: 7, alpha: 0.008 },
      { dy: 12, sigma: 16, alpha: 0.012 },
    ],
  },
} as const satisfies Record<string, ShadowSpec>;

export type SoftShadowPreset = keyof typeof PRESETS;

// 投影色黑 + 取 alpha 形状白（同 SoftShadow：仅决定投影颜色与形状，非主题色面）
const FLOOD_COLOR = '#000000';
const SHAPE_FILL = '#ffffff';

export interface SoftShadowSurfaceProps {
  /** 阴影规格档（几何对原型 CSS、α 逐档 sanctioned，见 PRESETS） */
  preset: SoftShadowPreset;
  /** 填充面圆角（dp）；胶囊传 radius.pill，SVG rx 自动截断到高/2 */
  borderRadius: number;
  /** 填充面色（内层填充节点为唯一绘制点；色值由宿主按主题决定） */
  fill: string;
  /** 内层填充面补充样式（如 Sheet 仅上圆角、浮层内边距） */
  fillStyle?: StyleProp<ViewStyle>;
  /** 定尺寸（定尺寸浮层可传，跳过首帧测量空窗）；缺省自测量 */
  width?: number;
  height?: number;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * 浮层容器软阴影面：外层（布局/被宿主动画）+ 内层填充裁剪面 + 底层 SVG 投影。
 *
 * ```tsx
 * <SoftShadowSurface preset="menu" borderRadius={theme.radius.menu}
 *   fill={theme.colors.surfaceRaised} style={{ position: 'absolute', top, right, width }}>
 *   {内容}
 * </SoftShadowSurface>
 * ```
 * 需要入场/位移动画时，把本组件包在宿主的 Animated.View 里（或反之把动画
 * 样式经 style 传入——本组件外层即 Animated.View，可直接吃 animated style）。
 */
export function SoftShadowSurface({
  preset,
  borderRadius,
  fill,
  fillStyle,
  width,
  height,
  children,
  style,
  testID,
}: SoftShadowSurfaceProps) {
  const theme = useTheme();
  const spec = PRESETS[preset];
  const [measured, setMeasured] = useState({ w: 0, h: 0 });
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width: w, height: h } = event.nativeEvent.layout;
    setMeasured((prev) =>
      Math.abs(prev.w - w) > 0.5 || Math.abs(prev.h - h) > 0.5 ? { w, h } : prev
    );
  }, []);
  const w = width ?? measured.w;
  const h = height ?? measured.h;
  // 短路口径同 SoftShadow：仅 Android 浅色渲染投影；尺寸未测得（首帧）先不画
  const showShadow = Platform.OS === 'android' && !theme.dark && w > 0 && h > 0;
  // 滤镜 id 按实例唯一化（同 SoftShadow：useId 剔除非字母数字，url(#) 寻址需净化）
  const filterId = `soft-surface-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  const pad = spec.pad;
  const W = w + pad * 2;
  const H = h + pad * 2;

  return (
    <View testID={testID} style={[styles.host, style]} onLayout={handleLayout}>
      {showShadow ? (
        <View
          collapsable={false}
          style={[styles.svg, { top: -pad, left: -pad }]}
          pointerEvents="none"
        >
          <Svg width={W} height={H} pointerEvents="none">
            <Defs>
              <Filter
                id={filterId}
                x={0}
                y={0}
                width={W}
                height={H}
                filterUnits="userSpaceOnUse"
              >
                {spec.layers.map((layer, index) => (
                  <ShadowLayerNodes key={index} index={index} layer={layer} />
                ))}
                <FeMerge>
                  {spec.layers.map((_layer, index) => (
                    <FeMergeNode key={index} in={`t${index}`} />
                  ))}
                </FeMerge>
              </Filter>
            </Defs>
            <SvgRect
              x={pad}
              y={pad}
              width={w}
              height={h}
              rx={borderRadius}
              ry={borderRadius}
              fill={SHAPE_FILL}
              filter={`url(#${filterId})`}
            />
          </Svg>
        </View>
      ) : null}
      {/* 内层填充面：唯一填充绘制点 + 圆角裁剪内容（-fill 后缀 testID 供渲染契约测试定位） */}
      <View
        testID={testID ? `${testID}-fill` : undefined}
        style={[
          styles.fill,
          { borderRadius, backgroundColor: fill },
          fillStyle,
        ]}
      >
        {children}
      </View>
    </View>
  );
}

/** 单层投影节点链：取源 alpha → 高斯模糊 → 偏移 → 染色 → 裁进偏移形状
 *  → 内渗切除（以源形状 alpha 做 out，轮廓内归零、只留轮廓外投影） */
function ShadowLayerNodes({
  index,
  layer,
}: {
  index: number;
  layer: ShadowLayer;
}) {
  return (
    <>
      <FeGaussianBlur
        in="SourceAlpha"
        stdDeviation={layer.sigma}
        result={`b${index}`}
      />
      <FeOffset in={`b${index}`} dx={0} dy={layer.dy} result={`o${index}`} />
      <FeFlood
        floodColor={FLOOD_COLOR}
        floodOpacity={layer.alpha}
        result={`c${index}`}
      />
      <FeComposite
        in={`c${index}`}
        in2={`o${index}`}
        operator="in"
        result={`s${index}`}
      />
      <FeComposite
        in={`s${index}`}
        in2="SourceAlpha"
        operator="out"
        result={`t${index}`}
      />
    </>
  );
}

const styles = StyleSheet.create({
  host: {
    // 外层不裁剪：投影出血区向四周溢出显示
    overflow: 'visible',
  },
  svg: {
    position: 'absolute',
  },
  fill: {
    // 填充面横向铺满外层、纵向随内容（自适应高度浮层不得写 100% 高，
    // 与外层互相依赖成环）；定高宿主经 fillStyle 自行给定。
    // overflow hidden = 内容裁剪（条目按压叠色/滚动内容不得画出圆角外）；
    // 裁剪只在内层——外层必须保持默认 visible 保阴影出血（渲染契约测试钉住）。
    alignSelf: 'stretch',
    overflow: 'hidden',
  },
});
