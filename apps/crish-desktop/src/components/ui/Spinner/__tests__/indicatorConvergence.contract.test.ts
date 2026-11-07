import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 持续指示收敛契约守卫（S8，E 类 9）
 *
 * 锁定三条不可回潮的架构事实：
 * 1. 旋转关键帧全仓单源：@keyframes crish-spin 只在 styles/indicators.css
 *    定义一份；历史上 11 个私有旋转变体（spin / button-spin / diag-spin /
 *    font-spin / switch-spin / contentStateSpin / flowSpin / rotateSpinner /
 *    spinKeyframe / sessionReadyCoverSpin / note-paper-spin）禁止复活。
 * 2. 脉冲点单源：dot 脉冲走全局正典 crish-pulse-dot（design-system.css）；
 *    私有脉冲变体只许以「登记例外」形态存在（AN2 裁定禁止合并的三面 +
 *    S8 登记的异力学/异色面 + 收口禁改待迁两面），登记表外一律违规；
 *    登记项被迁移后须同步删表（防登记腐烂）。
 * 3. 周期 token 单源：--duration-spin 1000ms / --duration-pulse 1600ms
 *    在 tokens-base.css 定义，--transition-spin / --transition-pulse 由其
 *    组合，TS 侧 motionTokens 以 DURATION_SPIN_MS / DURATION_PULSE_MS 镜像。
 */

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const APP_ROOT = join(DIR, '../../../../..');
const SRC_ROOT = join(APP_ROOT, 'src');

function walkCss(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkCss(full, out);
    } else if (entry.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

function keyframesOf(css: string): string[] {
  const names: string[] = [];
  for (const m of css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

const CSS_FILES = walkCss(SRC_ROOT, []);
const FOUND = new Map<string, Set<string>>();
for (const file of CSS_FILES) {
  const rel = relative(SRC_ROOT, file).replace(/\\/g, '/');
  FOUND.set(rel, new Set(keyframesOf(readFileSync(file, 'utf8'))));
}

/** 监视名单：一切私有旋转/脉冲关键帧名（正典 crish-* 与骨架族不在内） */
const WATCHED = new Set([
  'spin',
  'button-spin',
  'diag-spin',
  'font-spin',
  'switch-spin',
  'contentStateSpin',
  'flowSpin',
  'rotateSpinner',
  'spinKeyframe',
  'sessionReadyCoverSpin',
  'note-paper-spin',
  'agentDotPulse',
  'activePortPulse',
  'pulseDot',
  'session-running-pulse',
  'launcherPulse',
  'urgentBlink',
  'sync-dot-pulse',
  'flowPulse',
  'fileRowPulse',
  'toolDotPulseBlue',
  'groupDotPulseBlue',
]);

/** 登记例外：文件（src 相对路径）→ 允许存在的监视名单关键帧与理由 */
const REGISTERED: Record<string, Record<string, string>> = {
  // AN2 脉冲归队裁定（禁止合并）：光晕环扩张通道为本面独有
  'components/chat-message-row/FlowArtifactChip.module.css': {
    'sync-dot-pulse': 'AN2 登记：缩放+透明+光晕环扩张，文件同步芯片独有',
  },
  // AN2 脉冲归队裁定（禁止合并）：相位与正典相反（中点最暗最小）
  'components/workspace/PreviewCard.module.css': {
    pulseDot: 'AN2 登记：反相透明+缩放，预览卡运行点独有',
  },
  // AN2 脉冲归队裁定（禁止合并）：纯透明、无位移通道
  'extensions/conversation-flow/narrative.module.css': {
    flowPulse: 'AN2 登记：纯透明脉冲，叙事流运行指示独有',
  },
  // S8 登记：动画对象是整行背景洗光，不是圆点力学
  'components/sidebar/SidebarSessionList.module.css': {
    'session-running-pulse': 'S8 登记：运行会话行背景洗光，非圆点',
  },
  // S8 登记：涟漪扩散（ping 形、非呼吸点）。聚合点告警闪烁已按
  // 2026-11-06 裁决收敛常亮并删除；WATCHED 名单留名，复活即红
  'components/binary-tree/NewTabLauncherPopover.module.css': {
    launcherPulse: 'S8 登记：涟漪扩散 ping 形，非呼吸点',
  },
  // S8 登记：成功色圆点自带静态环，正典光晕为强调色，迁移会撞色双环
  'components/binary-tree/LeafToolTabStrip.module.css': {
    activePortPulse: 'S8 登记：成功色点+静态环，与正典光晕撞色',
  },
  // S8 登记：绿色运行点暗相位配方，正典光晕为强调色会撞色
  'components/overview/DockLauncherOverview.module.css': {
    pulseDot: 'S8 登记：绿色运行点暗相位，与正典光晕撞色',
  },
  // S8 登记：一次性定位高亮（单次播放），非持续指示，不入类 9
  'components/files/FilesCard.module.css': {
    fileRowPulse: 'S8 登记：文件行定位高亮，一次性非循环',
  },
  // 待迁登记：两文件在合并收口提交清单内（本批禁改），收口后迁正典并删表
  'components/chat-tool-call/ChatToolCallBlock.module.css': {
    toolDotPulseBlue: '待迁：收口禁改文件，收口后迁 crish-pulse-dot',
  },
  'components/chat-tool-call/FoldableToolGroup.module.css': {
    groupDotPulseBlue: '待迁：收口禁改文件，收口后迁 crish-pulse-dot',
  },
};

describe('持续指示收敛契约（S8 / E 类 9）', () => {
  it('旋转单源：crish-spin 只在 styles/indicators.css 定义一份', () => {
    const definers = [...FOUND.entries()]
      .filter(([, names]) => names.has('crish-spin'))
      .map(([file]) => file);
    expect(definers).toEqual(['styles/indicators.css']);
    const appearDefiners = [...FOUND.entries()]
      .filter(([, names]) => names.has('crish-indicator-appear'))
      .map(([file]) => file);
    expect(appearDefiners).toEqual(['styles/indicators.css']);
  });

  it('监视名单：登记表外不得存在私有旋转/脉冲关键帧', () => {
    const offenders: string[] = [];
    for (const [file, names] of FOUND) {
      for (const name of names) {
        if (!WATCHED.has(name)) continue;
        if (REGISTERED[file]?.[name]) continue;
        offenders.push(`${file} :: @keyframes ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('登记表不腐烂：每条登记例外都真实存在', () => {
    const stale: string[] = [];
    for (const [file, entries] of Object.entries(REGISTERED)) {
      for (const name of Object.keys(entries)) {
        if (!FOUND.get(file)?.has(name)) stale.push(`${file} :: ${name}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('周期 token 单源：tokens-base 定义 duration，transition 由其组合，TS 镜像同值', () => {
    const tokensBase = readFileSync(
      join(SRC_ROOT, 'styles/tokens-base.css'),
      'utf8'
    );
    expect(tokensBase).toContain('--duration-spin: 1000ms');
    expect(tokensBase).toContain('--duration-pulse: 1600ms');
    expect(tokensBase).toContain('--transition-spin: var(--duration-spin)');
    expect(tokensBase).toContain('--transition-pulse: var(--duration-pulse)');
    const motionTokens = readFileSync(
      join(SRC_ROOT, 'utils/motionTokens.ts'),
      'utf8'
    );
    expect(motionTokens).toContain('DURATION_SPIN_MS = 1000');
    expect(motionTokens).toContain('DURATION_PULSE_MS = 1600');
  });

  it('原语接线：Spinner/PulseDot 经全局工具类消费 crish-spin、crish-pulse-dot，周期全经令牌', () => {
    // keyframes 悬空修复批（2026-11-06）：模块 CSS 禁按名引用全局关键帧
    //（工具链改名后悬空），消费改走 design-system.css §4b 全局工具类
    // composes；本断言随之转指：模块侧钉 composes 接线，全局侧钉工具类
    // 本体仍是正典名 + 令牌周期（原语义不变）。
    const spinnerCss = readFileSync(
      join(SRC_ROOT, 'components/ui/Spinner/Spinner.module.css'),
      'utf8'
    );
    expect(spinnerCss).toMatch(/composes:\s*crish-anim-spin\s+from\s+global/);
    expect(spinnerCss).toMatch(
      /composes:\s*crish-anim-spin-appear\s+from\s+global/
    );
    const pulseDotCss = readFileSync(
      join(SRC_ROOT, 'components/ui/PulseDot/PulseDot.module.css'),
      'utf8'
    );
    expect(pulseDotCss).toMatch(
      /composes:\s*crish-anim-pulse-dot\s+from\s+global/
    );
    const indicatorsCss = readFileSync(
      join(SRC_ROOT, 'styles/indicators.css'),
      'utf8'
    );
    expect(indicatorsCss).toMatch(
      /\.crish-anim-spin\s*\{\s*animation:\s*crish-spin\s+var\(--transition-spin\)/
    );
    expect(indicatorsCss).toMatch(
      /\.crish-anim-spin-appear\s*\{[^}]*crish-indicator-appear\s+var\(--duration-fast\)/
    );
    const dsCss = readFileSync(
      join(SRC_ROOT, 'styles/design-system.css'),
      'utf8'
    );
    expect(dsCss).toMatch(
      /\.crish-anim-pulse-dot\s*\{\s*animation:\s*crish-pulse-dot\s+var\(--transition-pulse\)/
    );
  });
});
