// VoiceOverlay 单元测试：浮层状态切换、无描边硬指标、弧形胶囊排版与雷达隔离环断言。
import * as fs from 'fs';
import * as path from 'path';
import { StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { resetThemeModeForTest, setThemeMode } from '@/adapters/platform/theme';
import type { SharedValue } from 'react-native-reanimated';
import { VoiceOverlay } from './VoiceOverlay';

/** 测试用电平 SharedValue（浮层只在 animated style 内读 .value，普通对象即保真） */
const sharedLevel = (v: number): SharedValue<number> =>
  ({ value: v }) as SharedValue<number>;

function findNodes(
  node: ReactTestRendererJSON | string | null,
  predicate: (n: ReactTestRendererJSON) => boolean
): ReactTestRendererJSON[] {
  const result: ReactTestRendererJSON[] = [];
  function walk(curr: ReactTestRendererJSON | string | null) {
    if (!curr || typeof curr === 'string') return;
    if (predicate(curr)) result.push(curr);
    for (const child of curr.children ?? []) {
      walk(child);
    }
  }
  walk(node);
  return result;
}

describe('VoiceOverlay', () => {
  beforeEach(async () => {
    await act(async () => {
      resetThemeModeForTest();
      setThemeMode('light');
    });
  });

  afterEach(async () => {
    await act(async () => {
      resetThemeModeForTest();
    });
  });

  it('idle 态下不渲染任何 DOM 节点（诚实隐蔽）', async () => {
    const { toJSON } = await render(
      <VoiceOverlay
        phase="idle"
        starting={false}
        displayText=""
        level={sharedLevel(0)}
      />
    );
    expect(toJSON()).toBeNull();
  });

  it('彻底去除描边：centerTipBadge 与 previewCard 必须零边框（borderWidth = 0）', async () => {
    const { getByTestId, toJSON } = await render(
      <VoiceOverlay
        phase="cancelling"
        starting={false}
        displayText="测试语音转写"
        level={sharedLevel(0.5)}
      />
    );

    const container = getByTestId('voice-overlay-container');
    expect(container).toBeTruthy();

    const rootJson = toJSON() as ReactTestRendererJSON;

    // 1. 转写卡片：无任何描边
    const previewCards = findNodes(rootJson, (n) => {
      const s = StyleSheet.flatten(n.props?.style);
      return s?.minHeight === 88;
    });
    expect(previewCards.length).toBeGreaterThan(0);
    const cardStyle = StyleSheet.flatten(previewCards[0]!.props.style);
    expect(cardStyle.borderWidth ?? 0).toBe(0);

    // 2. HUD 提示胶囊：无任何描边
    const tipBadges = findNodes(rootJson, (n) => {
      const s = StyleSheet.flatten(n.props?.style);
      return s?.paddingHorizontal === 16 && s?.paddingVertical === 6;
    });
    expect(tipBadges.length).toBeGreaterThan(0);
    const badgeStyle = StyleSheet.flatten(tipBadges[0]!.props.style);
    expect(badgeStyle.borderWidth ?? 0).toBe(0);
  });

  it('圆弧胶囊文案排版紧凑单空格，防止末字被裁剪', async () => {
    // 1. 正常录音态
    const { toJSON: renderRecording } = await render(
      <VoiceOverlay
        phase="recording"
        starting={false}
        displayText=""
        level={sharedLevel(0)}
      />
    );
    const recJson = renderRecording() as ReactTestRendererJSON;
    const recSpans = findNodes(recJson, (n) => typeof n.props?.content === 'string');
    const recTexts = recSpans.map((n) => n.props.content);
    expect(recTexts).toContain('✕ 左滑撤销');
    expect(recTexts).toContain('右滑编辑 ✎');

    // 2. 撤销高亮态
    const { toJSON: renderCancelling } = await render(
      <VoiceOverlay
        phase="cancelling"
        starting={false}
        displayText=""
        level={sharedLevel(0)}
      />
    );
    const cancelJson = renderCancelling() as ReactTestRendererJSON;
    const cancelSpans = findNodes(cancelJson, (n) => typeof n.props?.content === 'string');
    const cancelTexts = cancelSpans.map((n) => n.props.content);
    expect(cancelTexts).toContain('✕ 松开撤销');
    expect(cancelTexts).toContain('右滑编辑 ✎');

    // 3. 编辑高亮态
    const { toJSON: renderEditing } = await render(
      <VoiceOverlay
        phase="editing"
        starting={false}
        displayText=""
        level={sharedLevel(0)}
      />
    );
    const editJson = renderEditing() as ReactTestRendererJSON;
    const editSpans = findNodes(editJson, (n) => typeof n.props?.content === 'string');
    const editTexts = editSpans.map((n) => n.props.content);
    expect(editTexts).toContain('✕ 左滑撤销');
    expect(editTexts).toContain('松开编辑 ✎');
  });

  it('正在聆听卡片背后挂载动态雷达隔离环', async () => {
    const { toJSON } = await render(
      <VoiceOverlay
        phase="recording"
        starting={false}
        displayText="正在聆听测试"
        level={sharedLevel(0)}
      />
    );
    const rootJson = toJSON() as ReactTestRendererJSON;
    const halos = findNodes(rootJson, (n) => {
      const s = StyleSheet.flatten(n.props?.style);
      return s?.position === 'absolute' && s?.alignSelf === 'center' && n.props?.pointerEvents === 'none';
    });
    expect(halos.length).toBeGreaterThanOrEqual(2);
  });

  it('长按触发 VoiceOverlay 挂载时，所有 TextPath 节点绝不携带 alignmentBaseline prop（防止 Android Fabric 崩溃）', async () => {
    // 模拟长按启动状态：starting 跃变为 true，visible 激活并挂载浮层
    const { toJSON } = await render(
      <VoiceOverlay
        phase="idle"
        starting={true}
        displayText=""
        level={sharedLevel(0)}
      />
    );
    const rootJson = toJSON() as ReactTestRendererJSON;
    expect(rootJson).not.toBeNull();

    // 查找所有 TextPath 节点
    const textPathNodes = findNodes(rootJson, (n) => {
      return (
        n.type === 'RNSVGTextPath' ||
        n.type === 'TextPath' ||
        (typeof n.props?.href === 'string' && n.props.href.includes('arc-track'))
      );
    });

    expect(textPathNodes.length).toBe(2);
    for (const node of textPathNodes) {
      // 在 react-native-svg 渲染器中，未传属性时解析值为 undefined，绝不能为 'central' 或其它字符串（规避 Native Fabric setMethod 枚举强转崩溃）
      expect(node.props.alignmentBaseline).toBeUndefined();
    }

    // 2026-11-05 崩溃根治（实机 5 次 IllegalArgumentException，见战役
    // findings/04 B3）：外层父级 SvgText 同样严禁 alignmentBaseline——
    // react-native-svg 会把该属性沿 SvgText→TextPath 继承链下发并在
    // Fabric 预分配视图时强转 TextPathMethod 枚举（无 central）即崩。
    // 旧口径"父级保留 central 用于原生继承"正是崩溃源，已反转。
    const svgTextNodes = findNodes(rootJson, (n) => {
      return (
        (n.type === 'RNSVGText' || n.type === 'SvgText' || n.type === 'Text') &&
        n.props?.alignmentBaseline !== undefined
      );
    });
    expect(svgTextNodes).toEqual([]);
  });

  it('源码级静态防回归断言：VoiceOverlay.tsx 代码行（含 SvgText/TextPath）严禁出现 alignmentBaseline', () => {
    const filePath = path.resolve(__dirname, 'VoiceOverlay.tsx');
    // 与 noShadow.guard 同口径：剔除整行注释后检查（注释中的禁令说明合法）
    const sourceCode = fs
      .readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

    // 匹配 <TextPath ...> 标签（支持单行与多行属性写法）
    const textPathMatches = sourceCode.match(/<TextPath\b[\s\S]*?>/g) ?? [];
    expect(textPathMatches.length).toBe(2);

    for (const tag of textPathMatches) {
      expect(tag).not.toContain('alignmentBaseline');
    }

    // 2026-11-05 扩面：父级 SvgText 也在禁令内（继承链下发即崩，见上）
    expect(sourceCode).not.toContain('alignmentBaseline');
  });
});

describe('VoiceOverlay 返工契约（2026-11-05：行程收敛 / 波形 UI 线程 / 道具删除）', () => {
  beforeEach(async () => {
    await act(async () => {
      resetThemeModeForTest();
      setThemeMode('light');
    });
  });

  afterEach(async () => {
    await act(async () => {
      resetThemeModeForTest();
    });
  });

  it('波形条由 level SharedValue 驱动：31 根齐备，中心条高随电平 0→1 由 8 涨至 28', async () => {
    const heightsWithLevel = async (v: number) => {
      const { toJSON } = await render(
        <VoiceOverlay
          phase="recording"
          starting={false}
          displayText=""
          level={sharedLevel(v)}
        />
      );
      const rootJson = toJSON() as ReactTestRendererJSON;
      const bars = findNodes(rootJson, (n) => {
        const s = StyleSheet.flatten(n.props?.style);
        return s?.width === 2.5 && typeof s?.height === 'number';
      });
      return bars.map(
        (n) => StyleSheet.flatten(n.props.style).height as number
      );
    };
    const quiet = await heightsWithLevel(0);
    const loud = await heightsWithLevel(1);
    expect(quiet.length).toBe(31);
    expect(loud.length).toBe(31);
    // 中心条 bell=1：静音 6 + min(22, 2) = 8；满电平 6 + 22 = 28
    expect(Math.max(...quiet)).toBe(8);
    expect(Math.max(...loud)).toBe(28);
  });

  it('源码契约：大球行程收敛 ±20/-10、变换原点钉底边中心，bottomInset 悬空道具已删除', () => {
    const filePath = path.resolve(__dirname, 'VoiceOverlay.tsx');
    const sourceCode = fs
      .readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(sourceCode).toContain('[-20, 0, 20]');
    expect(sourceCode).toContain('[-10, 0, 0]');
    expect(sourceCode).toContain("transformOrigin: '50% 100%'");
    expect(sourceCode).not.toContain('-65, 0, 65');
    expect(sourceCode).not.toContain('-30, 0, 0]');
    expect(sourceCode).not.toContain('bottomInset');
    // 电平只经 SharedValue 消费（UI 线程读 .value），不再有 number 道具算高
    expect(sourceCode).toContain('level.value');
  });
});
