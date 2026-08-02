import React, { useState } from 'react';
import {
  Solution1_1_CenterHero,
  Solution1_2_LeftColumn,
  Solution1_3_BottomLeftDock,
  Solution1_4_TopBarBeam,
  Solution1_5_FloatingDarkCard,
  Solution1_6_DiagonalSplit,
  Solution1_7_TripleColumn,
  Solution1_8_AsymmetricRightPortal,
} from './domain-1-monolith';
import {
  Domain2_1_GiantHeadline,
  Domain2_2_SplitScreen,
  Domain2_3_TopLeftMonogram,
  Domain2_4_CornerFrame,
  Domain2_5_TripleBand,
  Domain2_6_DiagonalCut,
  Domain2_7_StencilMatrix,
  Domain2_8_InvertedBox,
} from './domain-2-swiss-typo';
import {
  Solution3_1_QuadrantInterlock,
  Solution3_2_DiagonalBevels,
  Solution3_3_HexCoreMonolith,
} from './domain-3-interlock';
import {
  Solution4_1_GoldenRatio,
  Solution4_2_ReticleCorner,
} from './domain-4-asymmetric-grid';
import {
  Solution5_1_ObsidianSlab,
} from './domain-5-tactile-relief';
import {
  Solution6_1_HorizontalDualShutter,
} from './domain-6-shutter';

export interface LoadingSystemConcept {
  id: string;
  domain: string;
  code: string;
  nameZh: string;
  nameEn: string;
  layoutDescription: string;
  entranceAnimation: string;
  blockMotion: string;
  typographyMotion: string;
  renderScreen: () => React.ReactNode;
}

export const ARTON_48_SYSTEMS: LoadingSystemConcept[] = [
  // DOMAIN 1: 重型建筑金石与块面沉降 (1.1 - 1.8)
  {
    id: 's1-1',
    domain: 'Domain 1: 重型建筑金石与块面沉降',
    code: '1.1',
    nameZh: '金石重柱 居中中轴',
    nameEn: 'Monolith Column Center',
    layoutDescription: '居中大尺寸 3D 实体切角 A 字金石，配合下置超粗 ARTON 品牌名',
    entranceAnimation: '全屏黑色帷幕向上下双向张开 (Curtain Split Reveal)',
    blockMotion: '左右两大实心倾斜重柱从底部冲天降落，中梁重击吸附',
    typographyMotion: 'ARTON 从高斯模糊与 12px 偏移中重强力展露',
    renderScreen: () => <Solution1_1_CenterHero />,
  },
  {
    id: 's1-2',
    domain: 'Domain 1: 重型建筑金石与块面沉降',
    code: '1.2',
    nameZh: '建筑立柱 左下沉角',
    nameEn: 'Architectural Pillar Bottom-Left',
    layoutDescription: '左下角巨型 80px 实体柱结构，右上角放大的 ARTON 字形',
    entranceAnimation: '从左下角斜向延伸展开实心遮罩 (Diagonal Sweep Unveil)',
    blockMotion: '垂直 80px 实体黑白色块如建筑地基逐层升起',
    typographyMotion: '右上角 ARTON 字符沿对角线延伸擦除展露',
    renderScreen: () => <Solution1_2_LeftColumn />,
  },
  {
    id: 's1-3',
    domain: 'Domain 1: 重型建筑金石与块面沉降',
    code: '1.3',
    nameZh: '三段式重型基座 浮动卡',
    nameEn: 'Triple Section Horizontal Stack',
    layoutDescription: '顶部加粗线条带、中间实心 A 徽章、底部沉重 ARTON 基座',
    entranceAnimation: '三段式水平滑块如快门般由外向内锁定',
    blockMotion: '中间实心三角形与平行重型块面相互插锁',
    typographyMotion: '底部基座字符如浮雕字印自下而上弹出',
    renderScreen: () => <Solution1_3_BottomLeftDock />,
  },
  {
    id: 's1-4',
    domain: 'Domain 1: 重型建筑金石与块面沉降',
    code: '1.4',
    nameZh: '悬浮金石黑卡 顶梁',
    nameEn: 'Floating Dark Monolith Card',
    layoutDescription: '全屏居中悬浮带深沉阴影的黑曜石质感色块卡片',
    entranceAnimation: '背景中央高斯模糊遮罩淡出，黑卡微调缩放弹入',
    blockMotion: '四个实心角快门以 45 度角像机械爪吸附黑卡',
    typographyMotion: '卡片内部刻印 ARTON 字母闪烁凸显',
    renderScreen: () => <Solution1_4_TopBarBeam />,
  },
  {
    id: 's1-5',
    domain: 'Domain 1: 重型建筑金石与块面沉降',
    code: '1.5',
    nameZh: '右倾3/4异形切面 悬浮卡',
    nameEn: '3/4 Asymmetric Slash Panel',
    layoutDescription: '右侧占据 3/4 屏幕的深灰斜切实体遮罩，左侧露出 1/4 极简窄缝',
    entranceAnimation: '右侧斜切遮罩如大型暗室拉门自右向左推进',
    blockMotion: '窄缝处有白色实心光斑块从上至下平滑传导',
    typographyMotion: 'ARTON 在 3/4 主面板中央以 900 重字宽解构',
    renderScreen: () => <Solution1_5_FloatingDarkCard />,
  },
  {
    id: 's1-6',
    domain: 'Domain 1: 重型建筑金石与块面沉降',
    code: '1.6',
    nameZh: '45°对角斜切快门 对角切',
    nameEn: '45-Degree Diagonal Shutter',
    layoutDescription: '45 度对角将屏幕切割为上下两个哑光纯黑与深灰实体块面',
    entranceAnimation: '上下两大斜切块面沿 45 度切线向两头滑开',
    blockMotion: '切缝中 reveal 出 10px 厚度纯白光带与实心 A 字核心',
    typographyMotion: 'ARTON 字符在对角缝隙间逐字横向拉开',
    renderScreen: () => <Solution1_6_DiagonalSplit />,
  },
  {
    id: 's1-7',
    domain: 'Domain 1: 重型建筑金石与块面沉降',
    code: '1.7',
    nameZh: '双柱高耸门楼 柱廊',
    nameEn: 'Twin Pillar Archway',
    layoutDescription: '左右各一根占宽 20% 的高耸纯黑实心立柱，中间形成高拔门楼',
    entranceAnimation: '左右立柱如圣殿巨门自两侧向中心闭合',
    blockMotion: '立柱中央凹槽内有横向实心滑块交错沉降',
    typographyMotion: 'ARTON 字样垂直挂载于门楼天花板下沉展露',
    renderScreen: () => <Solution1_7_TripleColumn />,
  },
  {
    id: 's1-8',
    domain: 'Domain 1: 重型建筑金石与块面沉降',
    code: '1.8',
    nameZh: '包豪斯重型形体 右沉',
    nameEn: 'Bauhaus Heavy Geometry',
    layoutDescription: '由圆柱、正方实心块与斜切三角块组合的包豪斯极简构造',
    entranceAnimation: '三大包豪斯实体形体自屏幕四周向中心磁吸碰撞',
    blockMotion: '正方块与三角块发生 90 度步进式旋转扣合',
    typographyMotion: 'ARTON 在形体下方以极简无衬线全高显现',
    renderScreen: () => <Solution1_8_AsymmetricRightPortal />,
  },

  // DOMAIN 2: 瑞士重型排版与切片遮罩 (2.1 - 2.8)
  {
    id: 's2-1',
    domain: 'Domain 2: 瑞士重型排版与切片遮罩',
    code: '2.1',
    nameZh: '巨幅满铺扫描 居中巨字',
    nameEn: 'Full-Bleed Swiss Typography',
    layoutDescription: '84px 900 重黑体 ARTON 占满中轴，顶部与底部搭配纯白色块',
    entranceAnimation: '顶部与底部白块如快门扫过，中间留出黑底字形',
    blockMotion: '水平扫描色块做 0.2 秒高斯模糊擦除',
    typographyMotion: 'ARTON 逐字解构并在中轴展开 tracking',
    renderScreen: () => <Domain2_1_GiantHeadline />,
  },
  {
    id: 's2-2',
    domain: 'Domain 2: 瑞士重型排版与切片遮罩',
    code: '2.2',
    nameZh: '对半反色 split 对半分割',
    nameEn: 'Half & Half Inverted Split Screen',
    layoutDescription: '左白右黑极高对比度对半分割，ARTON 跨越交界处反色',
    entranceAnimation: '左侧纯白块面如铡刀般自上而下坠落盖合',
    blockMotion: '交界线做 0.5 秒高频实心块面卡位',
    typographyMotion: '跨越黑白交界的 ARTON 字符呈现完美负空间反色',
    renderScreen: () => <Domain2_2_SplitScreen />,
  },
  {
    id: 's2-3',
    domain: 'Domain 2: 瑞士重型排版与切片遮罩',
    code: '2.3',
    nameZh: '左上角巨型 A 字符 下落',
    nameEn: 'Top-Left Giant Letter Offset',
    layoutDescription: '左上角占据 200px 巨幅实心 A 字母剪影，右下角配小号 ARTON 说明',
    entranceAnimation: '左上角巨型 A 字母由 150% 超大缩放强力压印定位',
    blockMotion: 'A 字母中心负空间三角形块面做切片展露',
    typographyMotion: '右下角 ARTON 字符沿水平轨迹滑动对齐',
    renderScreen: () => <Domain2_3_TopLeftMonogram />,
  },
  {
    id: 's2-4',
    domain: 'Domain 2: 瑞士重型排版与切片遮罩',
    code: '2.4',
    nameZh: '四角角标框 框架',
    nameEn: 'Four Corner Bracket Frame',
    layoutDescription: '屏幕四角各有一个 40px 实心 L 型角标块，框定中央 ARTON 主字',
    entranceAnimation: '四角 L 型实心块从屏幕边缘向中心同时收缩夹紧',
    blockMotion: 'L 角标块在锁定时产生 2px 冲击回弹力',
    typographyMotion: '中央 ARTON 字符在角标框内做 Split-Text 显影',
    renderScreen: () => <Domain2_4_CornerFrame />,
  },
  {
    id: 's2-5',
    domain: 'Domain 2: 瑞士重型排版与切片遮罩',
    code: '2.5',
    nameZh: '三横栏擦除遮罩 三栏',
    nameEn: 'Triple Horizontal Eraser Band',
    layoutDescription: '三条等高水平深灰实心横栏分层交错分布',
    entranceAnimation: '第一、三横栏向右移动，第二横栏向左移动对冲',
    blockMotion: '横栏交错间隙露出现代主义纯黑背景',
    typographyMotion: 'ARTON 三部分随横栏对齐瞬间拼合显示',
    renderScreen: () => <Domain2_5_TripleBand />,
  },
  {
    id: 's2-6',
    domain: 'Domain 2: 瑞士重型排版与切片遮罩',
    code: '2.6',
    nameZh: '对角斜线切角 斜剪',
    nameEn: 'Diagonal Slash Typography Mask',
    layoutDescription: '左下至右上有一道 30 度斜向实心切缝遮罩',
    entranceAnimation: '斜向遮罩如快门叶片向两侧抽开',
    blockMotion: '切缝两侧的黑白色块产生错位平滑滑动',
    typographyMotion: 'ARTON 字母沿着斜向切线倾斜 15 度展开',
    renderScreen: () => <Domain2_6_DiagonalCut />,
  },
  {
    id: 's2-7',
    domain: 'Domain 2: 瑞士重型排版与切片遮罩',
    code: '2.7',
    nameZh: '镂空 Window 窗格 窗格',
    nameEn: 'Cutout Window Grid Mask',
    layoutDescription: '中央带矩形镂空窗口的重型纯黑遮罩，窗口内 reveal 色块与品牌',
    entranceAnimation: '矩形镂空窗口由中心点向四周呈方块扩充 (Box Iris Expand)',
    blockMotion: '窗口边缘有实心灰块做周相旋转',
    typographyMotion: '窗格内部 ARTON 字样做上下滚动走马灯',
    renderScreen: () => <Domain2_7_StencilMatrix />,
  },
  {
    id: 's2-8',
    domain: 'Domain 2: 瑞士重型排版与切片遮罩',
    code: '2.8',
    nameZh: '反转纯黑盒吸附 纯黑盒',
    nameEn: 'Inverted Solid Black Box Snap',
    layoutDescription: '纯白背景中央放置一块 300px * 180px 实心纯黑矩形盒',
    entranceAnimation: '纯黑矩形盒从全屏收缩至中央固定尺寸',
    blockMotion: '黑盒四周产生 4 块白色反色遮罩',
    typographyMotion: '黑盒内部镂空 reveal 出纯白 ARTON 字样',
    renderScreen: () => <Domain2_8_InvertedBox />,
  },

  // DOMAIN 3: 几何扣合与模块化拼装 (3.1 - 3.8)
  {
    id: 's3-1',
    domain: 'Domain 3: 几何扣合与模块化拼装',
    code: '3.1',
    nameZh: '2x2 模块马赛克 拼合',
    nameEn: '2x2 Tile Matrix Collapse',
    layoutDescription: '2x2 4 块实心正方形色块组成的紧凑阵列',
    entranceAnimation: '4 块实心正方形色块从屏幕 4 个角弹入并吸附至中心',
    blockMotion: '左上与右下色块做 90 度顺时针旋转，完成 A 字拼合',
    typographyMotion: '下列出现模块化字块拼成的 ARTON 单词',
    renderScreen: () => <Solution3_1_QuadrantInterlock />,
  },
  {
    id: 's3-2',
    domain: 'Domain 3: 几何扣合与模块化拼装',
    code: '3.2',
    nameZh: '错位斜切扣合 斜刃',
    nameEn: 'Offset Diagonal Bevel Lock',
    layoutDescription: '两块平行四边形重型实心斜板呈错位扣合姿态',
    entranceAnimation: '两块斜板沿 45 度轨线相对滑动，直至缺口扣合',
    blockMotion: '扣合瞬间产生卡扣机械震动反弹',
    typographyMotion: 'ARTON 字符在斜板表面呈现 45 度剪切倾斜',
    renderScreen: () => <Solution3_2_DiagonalBevels />,
  },
  {
    id: 's3-3',
    domain: 'Domain 3: 几何扣合与模块化拼装',
    code: '3.3',
    nameZh: '六边形悬浮切边 蜂窝',
    nameEn: 'Hexagonal Floating Wedges',
    layoutDescription: '居中实心正六边形，四周环绕 6 块楔形切片',
    entranceAnimation: '6 块楔形切片从外围向中心六边形径向收紧',
    blockMotion: '中心六边形沿 Z 轴凸起并分化出 A-T 连体徽印',
    typographyMotion: '六边形边缘环形擦除显示 ARTON 字符',
    renderScreen: () => <Solution3_3_HexCoreMonolith />,
  },

  // DOMAIN 4: 非对称空间网格与框架 (4.1 - 4.8)
  {
    id: 's4-1',
    domain: 'Domain 4: 非对称空间网格与框架',
    code: '4.1',
    nameZh: '黄金分割右倾 61.8/38.2',
    nameEn: 'Golden Ratio Asymmetric Right',
    layoutDescription: '左侧 61.8% 深灰主板，右侧 38.2% 亮黄实心立柱',
    entranceAnimation: '左右双板上下交错对冲划入',
    blockMotion: '右侧立柱内部 3 块实心色块做阶梯脉冲',
    typographyMotion: '左侧主板大尺寸 ARTON 字符横向展开',
    renderScreen: () => <Solution4_1_GoldenRatio />,
  },
  {
    id: 's4-2',
    domain: 'Domain 4: 非对称空间网格与框架',
    code: '4.2',
    nameZh: '4角刻度内嵌 4角重块',
    nameEn: '4-Reticle Corner Inset Slab',
    layoutDescription: '4 角巨型红/白色块包裹中央非对称舞台',
    entranceAnimation: '4 角重块向内夹紧，砸出震荡波',
    blockMotion: '中央菱形徽章做 90 度机械步进旋转',
    typographyMotion: '舞台中央 ARTON 粗体字从无到有放放展露',
    renderScreen: () => <Solution4_2_ReticleCorner />,
  },

  // DOMAIN 5: 阴刻压印与触感浮雕 (5.1 - 5.8)
  {
    id: 's5-1',
    domain: 'Domain 5: 阴刻压印与触感浮雕',
    code: '5.1',
    nameZh: '黑曜石阴刻块 凹陷 A 印',
    nameEn: 'Centered Obsidian Slab Relief',
    layoutDescription: '中央黑曜石沉降卡片，内部凹陷 3D 雕刻 A 字',
    entranceAnimation: '卡片带重影从上方坠落定位',
    blockMotion: 'A 字图形深深下陷，边缘亮光掠过',
    typographyMotion: 'ARTON 字母像字模般自下而上弹出',
    renderScreen: () => <Solution5_1_ObsidianSlab />,
  },

  // DOMAIN 6: 重型快门与折叠板块 (6.1 - 6.8)
  {
    id: 's6-1',
    domain: 'Domain 6: 重型快门与折叠板块',
    code: '6.1',
    nameZh: '水平双快门 水平双推',
    nameEn: 'Horizontal Dual Split Shutter',
    layoutDescription: '左右 50% 巨型实心装甲闸门',
    entranceAnimation: '中央锁扣旋转解脱，闸门向左右推开',
    blockMotion: '闸门平移暴露 negative space 黑色空间',
    typographyMotion: 'ARTON 品牌名在退开的深邃空间中极速展开',
    renderScreen: () => <Solution6_1_HorizontalDualShutter />,
  },
];

export function Arton48Catalog() {
  const [activeConceptId, setActiveConceptId] = useState<string>('s1-1');

  const activeConcept = ARTON_48_SYSTEMS.find((c) => c.id === activeConceptId) || ARTON_48_SYSTEMS[0];

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', backgroundColor: '#09090b', color: '#f4f4f5', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* 左侧 48 方案系统列表 Selector Navigation */}
      <div
        style={{
          width: '360px',
          height: '100%',
          borderRight: '1px solid rgba(255, 255, 255, 0.1)',
          backgroundColor: '#0f0f12',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 20,
        }}
      >
        <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 900, margin: 0, letterSpacing: '0.05em', color: '#ffffff' }}>
            ARTON LOAD SYSTEMS
          </h2>
          <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '4px' }}>
            48 套全屏重型加载动效系统 (Live GSAP Animation Engine)
          </div>
        </div>

        {/* 方案滚动列表 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {ARTON_48_SYSTEMS.map((concept) => {
            const isActive = concept.id === activeConceptId;
            return (
              <button
                key={concept.id}
                onClick={() => setActiveConceptId(concept.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 16px',
                  borderRadius: '10px',
                  border: isActive ? '1px solid rgba(255, 255, 255, 0.3)' : '1px solid transparent',
                  backgroundColor: isActive ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.02)',
                  color: isActive ? '#ffffff' : '#a1a1aa',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '8px',
                    backgroundColor: isActive ? '#f4f4f5' : '#18181b',
                    color: isActive ? '#09090b' : '#f4f4f5',
                    fontWeight: 900,
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {concept.code}
                </div>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: isActive ? 800 : 600, color: isActive ? '#ffffff' : '#e4e4e7' }}>
                    {concept.nameZh}
                  </div>
                  <div style={{ fontSize: '11px', color: '#71717a', marginTop: '2px' }}>{concept.nameEn}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右侧主全屏 3D/GSAP 动效渲染区 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          backgroundColor: '#000000',
          overflow: 'hidden',
        }}
      >
        {/* 方案系统规格说明浮条 */}
        <div
          style={{
            position: 'absolute',
            bottom: '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 90,
            padding: '14px 28px',
            backgroundColor: 'rgba(15, 15, 18, 0.92)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.16)',
            borderRadius: '16px',
            boxShadow: '0 12px 40px rgba(0,0,0,0.85)',
            width: '80%',
            maxWidth: '840px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '15px', fontWeight: 900, color: '#f4f4f5' }}>
              SYSTEM {activeConcept.code} : {activeConcept.nameZh} ({activeConcept.nameEn})
            </span>
            <span style={{ fontSize: '11px', color: '#a1a1aa', fontFamily: 'monospace' }}>{activeConcept.domain}</span>
          </div>
          <div style={{ fontSize: '12px', color: '#a1a1aa', marginTop: '4px' }}>
            📐 <b>排版布局</b>: {activeConcept.layoutDescription}
          </div>
          <div style={{ fontSize: '12px', color: '#a1a1aa' }}>
            🚪 <b>引导进场</b>: {activeConcept.entranceAnimation}
          </div>
          <div style={{ fontSize: '12px', color: '#a1a1aa' }}>
            ⬛ <b>实体块面与动效</b>: {activeConcept.blockMotion}
          </div>
        </div>

        {/* 渲染独立全屏 GSAP 动效画面 */}
        <div className="system-stage" style={{ width: '100%', height: '100%' }}>
          {activeConcept.renderScreen()}
        </div>
      </div>
    </div>
  );
}
