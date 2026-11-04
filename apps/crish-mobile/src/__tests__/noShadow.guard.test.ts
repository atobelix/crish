// 原生阴影守卫（2026-11-02 收编定案，防回潮）：
//
// 口径沿革：用户先裁决「去阴影、改亮度台阶」（Android 只认 elevation 并由
// 系统 Material 光照模型合成阴影——无模糊/透明度旋钮，灰度天生远重于原型
// 的 CSS --btn-shadow α0.8%/1.2%），阴影体系整体退役（theme 删除
// ThemeShadow / Theme.shadow / colors.shadow / makeShadow 工厂，22 消费点
// 摘除）。其后 SVG 软阴影实现经用户拍板收编为正式方案，口径更新为：
// 【原生阴影全面禁用，SoftShadow 是全 App 唯一合法阴影路径】：
// - elevation 一切赋值禁止：现行树上已无任何来源给点名面设 elevation，
// 连 `elevation: 0` 的字面量展开都是死代码（分析定案），一并禁绝；
// - shadow* 样式键/读取禁止（iOS 亦无阴影，如实登记）；
// - theme.shadow 体系不得复活（本守卫 + styleTokens 的退役断言双钉）；
// - SoftShadow.tsx 的规格常量（button 档 dy0 σ3 α0.008 / dy0 σ8 α0.012、composer 档
// dy0 σ5 α0.018 / dy0 σ14 α0.024）在此钉版，改规格须经用户
// 裁决；其合并输出不得含源图形（填充归宿主单绘），且每层投影须经
// operator="out" 内渗切除（轮廓内零投影）、滤镜区域须为
// userSpaceOnUse 全画布（结构钉版见下方专测）。
// - 阴影上限与四周均匀沿革：2026-11-02 晚用户硬裁决曾定「任何阴影不得深于按钮极软
//   规格」（全部预设 α 恒近 0.008 / 远 0.012；原型逐面 α——menu 0.08 /
//   dialog 0.16 / toast 0.15 / banner 0.05 等——作废，大表面只许放大几何）。
//   2026-11-03 二次校准曾微调为 0.013/0.019，真机反馈按钮四周不均匀、有偏心坠感。
//   **2026-11-03 原型极软与四周均匀校准（现行定案）**：
//   近层改为各向同性 dy=0 σ3（360° 均匀漫射提供空气微气垫），远层微下沉收敛为 dy=2 σ8；
//   button 档严格还原原型 reference/crish-mobile-drawer/index.html 权威 α（近 0.008 / 远 0.012）；
//   旧放大值（0.038/0.042/0.068/0.072）与过渡值（0.013/0.019/0.018/0.027）全部列入回潮断言。
// 本守卫以源码纪律钉住点名面（代码行口径与 roundButton 守卫同：整行注释
// 剔除），运行时形状由 roundButton 守卫的渲染断言钉住。
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

/** 只看代码行（整行注释剔除），与 roundButton / styleTokens 守卫同口径 */
function codeOf(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/** 曾消费 theme.shadow 或手写阴影的全部点名面（去阴影批 22 消费点所在
 * 文件）+ 唯一合法阴影渲染器 SoftShadow.tsx 本体（自证不含原生阴影） */
const NAMED_FILES = [
  'src/presentation/account/accountProfileScreen.tsx',
  'src/presentation/account/ui/AuthButton.tsx',
  'src/presentation/components/approval/ApprovalFloatCard.tsx',
  'src/presentation/components/approval/ApprovalFloatPill.tsx',
  'src/presentation/components/chat/DevicePill.tsx',
  'src/presentation/components/chat/SessionHeader.tsx',
  'src/presentation/components/drawer/CrishDrawerContent.tsx',
  'src/presentation/components/drawer/CrishDrawerLayout.tsx',
  'src/presentation/components/settings/SettingsSwitch.tsx',
  'src/presentation/components/status/ConnectionBanner.tsx',
  'src/presentation/screens/sessionDetailScreen.tsx',
  'src/presentation/timeline/TimelineView.tsx',
  'src/presentation/ui/Composer.tsx',
  'src/presentation/ui/Dialog.tsx',
  'src/presentation/ui/DropdownMenu.tsx',
  'src/presentation/ui/IconButton.tsx',
  'src/presentation/ui/Sheet.tsx',
  'src/presentation/ui/SoftShadow.tsx',
  'src/presentation/ui/SoftShadowSurface.tsx',
  'src/presentation/ui/pressFeedback.tsx',
  'src/presentation/ui/Toast.tsx',
  'src/presentation/ui/VoiceOverlay.tsx',
] as const;

const BANNED: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    pattern: /\belevation\b/,
    label: 'elevation（一切赋值，含 0 字面量死代码）',
  },
  {
    pattern: /\bshadow(Opacity|Color|Radius|Offset)\b/,
    label: 'shadow* 样式键/读取',
  },
  {
    pattern: /\.shadow\b/,
    label: '.shadow 成员访问（theme.shadow / colors.shadow）',
  },
];

describe('原生阴影守卫：点名面零 elevation / shadow*', () => {
  for (const rel of NAMED_FILES) {
    it(`${rel} 无原生阴影`, () => {
      const code = codeOf(rel);
      for (const { pattern, label } of BANNED) {
        expect({ rel, label, hit: pattern.test(code) }).toEqual({
          rel,
          label,
          hit: false,
        });
      }
    });
  }

  it('theme.ts：阴影工厂 / 类型 / 字段 / 色令牌全部退役', () => {
    const code = codeOf('src/adapters/platform/theme.ts');
    expect(code).not.toMatch(/makeShadow/);
    expect(code).not.toMatch(/ThemeShadow/);
    expect(code).not.toMatch(/\bshadow\s*:/);
    for (const { pattern } of BANNED) {
      expect(pattern.test(code)).toBe(false);
    }
  });

  it('抽屉零投影（2026-11-02 晚裁决）：侧边抽屉布局不引任何阴影渲染器', () => {
    // 抽屉只靠遮罩/色阶/圆角分层——CrishDrawerLayout 代码行不得出现
    // SoftShadow / SoftShadowSurface（其内容里的抽屉搜索胶囊是六个定案
    // 悬浮面之一、在 CrishDrawerContent，不在此列）
    const code = codeOf(
      'src/presentation/components/drawer/CrishDrawerLayout.tsx'
    );
    expect(code).not.toMatch(/SoftShadow/);
  });

  it('亮度台阶补偿在位：浮动按钮/胶囊的无模糊端填充走 surfaceRaised', () => {
    // 深色与无阴影面的区分靠亮度台阶：IconButton 填充节点、DevicePill
    // 胶囊、SessionHeader 标题胶囊的填充均已提亮到 surfaceRaised 台阶
    expect(codeOf('src/presentation/ui/IconButton.tsx')).toMatch(
      /surfaceRaised/
    );
    expect(codeOf('src/presentation/components/chat/DevicePill.tsx')).toMatch(
      /surfaceRaised/
    );
    expect(
      codeOf('src/presentation/components/chat/SessionHeader.tsx')
    ).toMatch(/surfaceRaised/);
  });
});

describe('SoftShadow：唯一合法阴影路径（收编定案）', () => {
  const REL = 'src/presentation/ui/SoftShadow.tsx';

  it('规格常量钉版：两档 α / σ / dy（2026-11-03 原型极软与四周均匀校准）', () => {
    const code = codeOf(REL);
    // button 档：近 0 0px 6px α0.008 + 远 0 0px 16px α0.012（四向严格均匀散射，对标原型 --btn-shadow）
    expect(code).toContain('dy: 0, sigma: 3, alpha: 0.008');
    expect(code).toContain('dy: 0, sigma: 8, alpha: 0.012');
    // composer 档：各向同性 360° 均匀温润弥散（近 σ3 α0.010 + 远 σ8 α0.014，内渗彻底切除，通透空气微气垫）
    expect(code).toContain('dy: 0, sigma: 3, alpha: 0.010');
    expect(code).toContain('dy: 0, sigma: 8, alpha: 0.014');
    // 出血 PAD 适度收敛为 36（容纳远层 σ8 的 3σ=24px 出血口径，彻底杜绝 GPU 显存卡顿）
    expect(code).toContain('const PAD = 36');
    // 旧过渡档值不得回潮
    expect(code).not.toContain('alpha: 0.013');
    expect(code).not.toContain('alpha: 0.019');
    expect(code).not.toContain('alpha: 0.027');
    // 畸高发黑放大值已废止，不得回潮
    expect(code).not.toContain('alpha: 0.038');
    expect(code).not.toContain('alpha: 0.042');
    expect(code).not.toContain('alpha: 0.05');
    expect(code).not.toContain('alpha: 0.068');
    expect(code).not.toContain('alpha: 0.07');
    expect(code).not.toContain('alpha: 0.072');
    expect(code).not.toContain('alpha: 0.08');
  });

  it('内渗切除 + 全画布滤镜区在位（2026-11-03 二次校准结构钉版）', () => {
    const code = codeOf(REL);
    // 每层投影合并前以源形状 alpha 做 out 切除：轮廓内零投影、内部不渗
    expect(code).toContain('operator="out"');
    expect(code).toContain('in2="SourceAlpha"');
    // 滤镜区域 userSpaceOnUse 全画布：百分比区随包围盒缩放、小宿主裁影
    expect(code).toMatch(/filterUnits="userSpaceOnUse"/);
  });

  it('只画阴影不画填充：合并输出不含源图形（填充归宿主单绘）', () => {
    expect(codeOf(REL)).not.toMatch(/SourceGraphic/);
  });

  it('深色短路在位：渲染器按 theme.dark 返回空', () => {
    expect(codeOf(REL)).toMatch(/theme\.dark/);
  });

  it('接入面只经 SoftShadow：六个原型点名悬浮面均渲染它（收口批补齐余下三面）', () => {
    // 原型点名悬浮面（构建分析定案）：汉堡/抽屉圆钮组（IconButton）、
    // 抽屉搜索胶囊、设备胶囊、输入卡、会话标题胶囊——全部只经 SoftShadow
    //
    // 匹配口径 = SoftShadow 家族用点（2026-11-02 对账修订，统一全块）：
    // 直渲 <SoftShadow …> 与 memo 包装 <MemoSoftShadow …> 同为合法用点。
    // 起因：PERF M4 修复把 Composer 的用点改名为 memo(SoftShadow) 包装
    // （逐帧重栅格化治理）——阴影本体与规格未动、只是隔了 memo 层，旧
    // 口径以字面 <SoftShadow 扫源码命不中、误报 1 红。家族口径以单一
    // 正则钉全部接入面：用点改名/摘除仍会红，memo 化不再误报；尾界
    // [\s>] 防与 SoftShadowSurface 家族串扰。
    const SOFT_SHADOW_USAGE = /<(Memo)?SoftShadow[\s>]/;
    expect(codeOf('src/presentation/ui/IconButton.tsx')).toMatch(
      SOFT_SHADOW_USAGE
    );
    expect(
      codeOf('src/presentation/components/drawer/CrishDrawerContent.tsx')
    ).toMatch(SOFT_SHADOW_USAGE);
    expect(codeOf('src/presentation/components/chat/DevicePill.tsx')).toMatch(
      SOFT_SHADOW_USAGE
    );
    expect(codeOf('src/presentation/ui/Composer.tsx')).toMatch(
      SOFT_SHADOW_USAGE
    );
    expect(
      codeOf('src/presentation/components/chat/SessionHeader.tsx')
    ).toMatch(SOFT_SHADOW_USAGE);
  });

  it('滤镜 id 按实例唯一化：不得写死共享 id（多宿主同屏串扰防线）', () => {
    const code = codeOf(REL);
    expect(code).not.toContain('id="btn-shadow"');
    expect(code).not.toContain('url(#btn-shadow)');
    expect(code).toMatch(/useId\(\)/);
  });
});

describe('SoftShadowSurface：容器外阴影唯一路径（容器外阴影批，2026-11-02）', () => {
  const REL = 'src/presentation/ui/SoftShadowSurface.tsx';

  it('预设规格钉版：几何沿原型浮层 CSS、α 逐档 sanctioned（button 档 2026-11-03 原型极软校准，余档恒 0.008/0.012）', () => {
    const code = codeOf(REL);
    // button：--btn-shadow 本档 0 0px 6px α0.008 + 0 0px 16px α0.012（与 SoftShadow button 档同值，四向均匀）
    expect(code).toContain('dy: 0, sigma: 3, alpha: 0.008');
    expect(code).toContain('dy: 0, sigma: 8, alpha: 0.012');
    // button 出血回 32（与本文件 pad 公式 3σmax+|dy|max+2 = 24+0+2 一致）
    expect(code).toMatch(/button: \{\s+pad: 32,/);
    // menu：dropdown-menu 几何（近 0 4px 12px + 远 0 10px 30px），α 已收敛
    expect(code).toContain('dy: 4, sigma: 6, alpha: 0.008');
    expect(code).toContain('dy: 10, sigma: 15, alpha: 0.012');
    // dialog：modal-dialog-card 几何（近 0 8px 20px + 远 0 20px 48px）
    expect(code).toContain('dy: 8, sigma: 10, alpha: 0.008');
    expect(code).toContain('dy: 20, sigma: 24, alpha: 0.012');
    // sheetUp：sheet-panel 几何（近 0 -4px 14px + 远 0 -10px 32px，上向）
    expect(code).toContain('dy: -4, sigma: 7, alpha: 0.008');
    expect(code).toContain('dy: -10, sigma: 16, alpha: 0.012');
    // floatCard：审批浮卡几何（近 0 4px 14px + 远 0 10px 36px）
    expect(code).toContain('dy: 4, sigma: 7, alpha: 0.008');
    expect(code).toContain('dy: 10, sigma: 18, alpha: 0.012');
    // toast：toast-pill 几何（近 0 2px 6px + 远 0 4px 12px；墨色胶囊无免阴影例外）
    expect(code).toContain('dy: 4, sigma: 6, alpha: 0.012');
    // banner：按钮档放大半径（近 0 2px 10px + 远 0 6px 24px，用户裁决横幅同档）
    expect(code).toContain('dy: 2, sigma: 5, alpha: 0.008');
    expect(code).toContain('dy: 6, sigma: 12, alpha: 0.012');
    // voiceCard：voice-recording-card 几何（近 0 5px 14px + 远 0 12px 32px）
    expect(code).toContain('dy: 5, sigma: 7, alpha: 0.008');
    expect(code).toContain('dy: 12, sigma: 16, alpha: 0.012');
  });

  it('α 上限钉死：原型逐面 α（0.05–0.16）与波 3 放大值不得回潮', () => {
    const code = codeOf(REL);
    for (const banned of [
      'alpha: 0.05',
      'alpha: 0.08',
      'alpha: 0.15',
      'alpha: 0.16',
      // 旧过渡值（2026-11-03 原型极软校准废止）
      'alpha: 0.013',
      'alpha: 0.019',
      'alpha: 0.018',
      'alpha: 0.027',
      // 波 3 放大值（2026-11-03 二次校准废止）
      'alpha: 0.038',
      'alpha: 0.042',
      'alpha: 0.068',
      'alpha: 0.072',
    ]) {
      expect(code).not.toContain(banned);
    }
  });

  it('内渗切除在位（2026-11-03 二次校准，与 SoftShadow 同步）', () => {
    const code = codeOf(REL);
    expect(code).toContain('operator="out"');
    expect(code).toContain('in2="SourceAlpha"');
  });

  it('原生阴影禁令同生效：零 elevation / shadow* / .shadow', () => {
    const code = codeOf(REL);
    for (const { pattern, label } of BANNED) {
      expect({ rel: REL, label, hit: pattern.test(code) }).toEqual({
        rel: REL,
        label,
        hit: false,
      });
    }
  });

  it('滤镜 id 按实例唯一化（多浮层同屏串扰防线）', () => {
    const code = codeOf(REL);
    expect(code).toMatch(/useId\(\)/);
    expect(code).not.toContain('url(#soft-surface-');
  });

  it('容器浮层只经 SoftShadowSurface：下拉/弹窗/Sheet/审批浮卡·胶囊/回底钮/Toast/录音卡/横幅', () => {
    expect(codeOf('src/presentation/ui/DropdownMenu.tsx')).toMatch(
      /SoftShadowSurface/
    );
    expect(codeOf('src/presentation/ui/Dialog.tsx')).toMatch(
      /SoftShadowSurface/
    );
    expect(codeOf('src/presentation/ui/Sheet.tsx')).toMatch(
      /SoftShadowSurface/
    );
    expect(
      codeOf('src/presentation/components/approval/ApprovalFloatCard.tsx')
    ).toMatch(/SoftShadowSurface/);
    expect(
      codeOf('src/presentation/components/approval/ApprovalFloatPill.tsx')
    ).toMatch(/SoftShadowSurface/);
    expect(codeOf('src/presentation/ui/ScrollToBottomButton.tsx')).toMatch(
      /SoftShadowSurface/
    );
    expect(codeOf('src/presentation/ui/Toast.tsx')).toMatch(
      /SoftShadowSurface/
    );
    expect(codeOf('src/presentation/ui/VoiceOverlay.tsx')).toMatch(
      /SoftShadowSurface/
    );
    expect(
      codeOf('src/presentation/components/status/ConnectionBanner.tsx')
    ).toMatch(/SoftShadowSurface/);
  });

  it('深色/平台短路在位：Android + 浅色才渲染投影', () => {
    const code = codeOf(REL);
    expect(code).toMatch(/theme\.dark/);
    expect(code).toMatch(/Platform\.OS === 'android'/);
  });
});
