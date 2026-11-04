// SVG 软阴影——Android 上精确还原原型 --btn-shadow 家族的两层高斯投影。
// 全 App 唯一阴影路径（收编定案，2026-11-02）：原生阴影全面禁用（Android
// 的系统 elevation 合成没有模糊/透明度旋钮、灰度天生远重于原型；iOS 的
// shadow* 同禁），一切阴影只能经本组件（小面）与 SoftShadowSurface
// （浮层容器）渲染，规格常量由 noShadow 守卫钉版。
//
// 规格沿革：
// - 原型本档（--btn-shadow）：近层 0 2px 6px rgba(0,0,0,0.008) + 远层
//   0 6px 16px rgba(0,0,0,0.012)；2026-11-02 晚用户硬裁决曾立为全 App
//   上限（Δcore=3±1 / Δpeak≤5）——该上限对本组件两档已由下方二次校准
//   取代（其余表面不变）。
// - 2026-11-03 波 3 校准（已废止，不得回潮）：按单层百分点上调且几何
//   同步放大——button 档近 α0.038 / 远 α0.042、composer 档近 α0.068 /
//   远 α0.072，几何 dy3 σ4 / dy8 σ11、PAD 44。真机 verdict：太重发黑、
//   衰减方向不均、投影渗进输入框内部。病灶：单层口径忽略了双层合成
//   （a+b−ab）与几何放大对衰减剖面的放大效应。
// - **2026-11-03 原型极软与四周均匀校准（现行 sanctioned 裁决）**：
//   针对按钮四周阴影不均与深色下坠感，结合原型 reference/crish-mobile-drawer/index.html
//   （--btn-shadow: 0 2px 6px rgba(0,0,0,0.008), 0 6px 16px rgba(0,0,0,0.012)）
//   严格对照重构：
//   1. 解决四周不均匀：近层改各向同性 dy=0 σ3（CSS 6px），360° 均匀漫反射提供环境微气垫；
//      远层微下沉收敛为 dy=2 σ8（CSS 16px），避免小圆钮上 6px 偏心被 operator="out" 挖秃上方；
//   2. 回归极软通透：button 档还原原型权威 α（近 0.008 / 远 0.012，峰值灰度严格 ≤ 2%），
//      彻底消除发暗与脏感，浅灰底色上呈现空气微气垫质感；composer 档相应平准为 0.010 / 0.014。
// 结构沿革（同为 2026-11-03 二次校准）：
// - 滤镜区域改 userSpaceOnUse 全画布（与 SoftShadowSurface 同口径）：
//   百分比区随元素包围盒缩放——高 <PAD 的小宿主（胶囊/圆钮）上滤镜区
//   覆盖不全画布、按方向裁掉衰减尾，是方向不均的结构源之一，收敛之。
// - 内渗切除：每层投影在合并前以源形状 alpha 做 operator="out" 切除
//   （见 ShadowLayerNodes）。两层投影本是源轮廓的模糊副本，其内部平台
//   恒覆盖轮廓内部；宿主填充若由父级 backgroundColor 承担（Composer
//   卡、设备胶囊、标题胶囊、抽屉搜索胶囊皆此式——父级底色画在子节点
//   之下），平台会盖在填充之上形成内渗（波 3 α 下实机整卡发灰、上沿
//   因 dy 偏移留亮带、上下不均）。切除后投影恒只存在于轮廓之外、内
//   部零渗，与宿主填充的绘制方式无关。SoftShadowSurface 同步同切除。
// 本组件只画阴影、不画填充：滤镜的合并输出只含两层投影（且经切除只
// 含轮廓之外的部分），取 alpha 的源矩形不进入输出；可见填充由宿主自
// 己的填充层单一绘制。
// 短路口径：
// - iOS：返回 null——iOS 无阴影（如实登记），区分靠宿主的玻璃/亮度台阶填充；
// - 深色主题：返回 null——深色区分统一走 surfaceRaised 亮度台阶（输入
//   卡在深色下另有 borderStrong 描边保边，见 Composer）。
import { useId } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
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

// 画布向外扩 PAD，为远层 σ8（3σ=24px）留足出血余量（36>24）
const PAD = 36;

// 投影规格常数（投影色黑 + 取 alpha 形状白）：仅决定投影的颜色与形状，
// 不是主题色面——styleTokens 守卫以白名单收录本文件。
const FLOOD_COLOR = '#000000';
// 取 alpha 的源矩形填充：不透明保证投影强度 = 规格原值；矩形本身不进入
// 合并输出，不是可见填充（可见填充由宿主填充层单一绘制）。
const SHAPE_FILL = '#ffffff';

/** 单层投影规格（dy 可负 = 上向；sigma = CSS blur / 2；alpha 为 sanctioned 值） */
interface ShadowLayer {
  readonly dy: number;
  readonly sigma: number;
  readonly alpha: number;
}

/**
 * 阴影档位（2026-11-03 原型极软与四周均匀校准）：
 * - button：平常按钮/胶囊档（双层全各向同性 dy0，360° 严格四向均匀散射，近 σ3 α0.008 + 远 σ8 α0.012，1:1 对标原型 --btn-shadow）；
 * - composer：消息输入框卡专用档（双层全各向同性 dy0，360° 柔和温润弥散气垫，近 σ3 α0.010 + 远 σ8 α0.014，内渗彻底切除，浅灰底色上呈现极软空气浮雕微气垫，绝不发黑）。
 */
export type SoftShadowVariant = 'button' | 'composer';

const SPECS: Record<SoftShadowVariant, readonly ShadowLayer[]> = {
  button: [
    { dy: 0, sigma: 3, alpha: 0.008 },
    { dy: 0, sigma: 8, alpha: 0.012 },
  ],
  composer: [
    { dy: 0, sigma: 3, alpha: 0.01 },
    { dy: 0, sigma: 8, alpha: 0.014 },
  ],
};

export interface SoftShadowProps {
  width: number;
  height: number;
  /** 圆角（dp）；传 height/2 得胶囊；传 9999 SVG 自动截断到 height/2 */
  borderRadius?: number;
  /** 阴影档位（缺省 button；Composer 卡传 composer） */
  variant?: SoftShadowVariant;
}

/**
 * 在 Android 浅色主题下用 react-native-svg 滤镜重现两层软阴影。
 * 只渲染阴影本身（绝对定位、向四周溢出 PAD=32px 出血区），且投影恒
 * 只在宿主轮廓之外（内渗切除，见文件头）；宿主须自行在其上层绘制填
 * 充与内容：
 *
 * ```tsx
 * <View style={{ width, height }}>
 *   <SoftShadow width={width} height={height} borderRadius={r} />
 *   {/* 宿主填充层 + 实际内容 *\/}
 * </View>
 * ```
 */
export function SoftShadow({
  width,
  height,
  borderRadius = 0,
  variant = 'button',
}: SoftShadowProps) {
  const theme = useTheme();
  // 滤镜 id 按实例唯一化（收口批）：SVG filter id 在同一渲染面内全局寻址，
  // 多个宿主同屏（或未来新增规格层）共用写死 id 会互相串扰——以 useId
  // 派生并剔除非字母数字字符（React useId 含冒号，url(#…) 寻址需净化）。
  const filterId = `soft-shadow-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  if (Platform.OS === 'ios') return null;
  if (theme.dark) return null;
  if (width <= 0 || height <= 0) return null;

  const layers = SPECS[variant];
  const W = width + PAD * 2;
  const H = height + PAD * 2;

  return (
    <View collapsable={false} style={styles.svg} pointerEvents="none">
      <Svg width={W} height={H} pointerEvents="none">
        <Defs>
          {/* 滤镜区域以 userSpaceOnUse 钉全画布（与 SoftShadowSurface 同
              口径，2026-11-03 二次校准）：百分比区随包围盒缩放、小宿主
              上覆盖不全画布；全画布区由 PAD 出血保证各向覆盖均匀 */}
          <Filter
            id={filterId}
            x={0}
            y={0}
            width={W}
            height={H}
            filterUnits="userSpaceOnUse"
          >
            {layers.map((layer, index) => (
              <ShadowLayerNodes
                key={index}
                index={index}
                layer={layer}
                withOutCut={true}
              />
            ))}
            {/* 合并输出只有各层投影——源图形不入输出，填充归宿主单绘 */}
            <FeMerge>
              {layers.map((_layer, index) => (
                <FeMergeNode key={index} in={`t${index + 1}`} />
              ))}
            </FeMerge>
          </Filter>
        </Defs>

        {/* 取 alpha 的源矩形：不透明填充保证投影强度 = 规格原值 */}
        <SvgRect
          x={PAD}
          y={PAD}
          width={width}
          height={height}
          rx={borderRadius}
          ry={borderRadius}
          fill={SHAPE_FILL}
          filter={`url(#${filterId})`}
        />
      </Svg>
    </View>
  );
}

/** 单层投影节点链：取源 alpha → 高斯模糊 → 偏移 → 染色 → 裁进偏移形状
 *  → 内渗切除（以源形状 alpha 做 out，轮廓内归零、只留轮廓外投影） */
function ShadowLayerNodes({
  index,
  layer,
  withOutCut,
}: {
  index: number;
  layer: ShadowLayer;
  withOutCut: boolean;
}) {
  const n = index + 1;
  return (
    <>
      <FeGaussianBlur
        in="SourceAlpha"
        stdDeviation={layer.sigma}
        result={`b${n}`}
      />
      <FeOffset in={`b${n}`} dx={0} dy={layer.dy} result={`o${n}`} />
      <FeFlood
        floodColor={FLOOD_COLOR}
        floodOpacity={layer.alpha}
        result={`c${n}`}
      />
      {withOutCut ? (
        <>
          <FeComposite
            in={`c${n}`}
            in2={`o${n}`}
            operator="in"
            result={`s${n}`}
          />
          <FeComposite
            in={`s${n}`}
            in2="SourceAlpha"
            operator="out"
            result={`t${n}`}
          />
        </>
      ) : (
        <FeComposite
          in={`c${n}`}
          in2={`o${n}`}
          operator="in"
          result={`t${n}`}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  svg: {
    position: 'absolute',
    // 向四周外扩 PAD，使阴影出血区不被父 View 的包围盒截断
    top: -PAD,
    left: -PAD,
  },
});
