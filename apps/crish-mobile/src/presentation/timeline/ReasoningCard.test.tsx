// 思考链卡片与抽屉展示单测：
// 严格覆盖：
// 1. 完成思考后默认折叠断言（status='done' 默认折叠、thinking->done 状态翻转刚性折叠、手动展开/收起）；
// 2. 160dp 限高区域滚动属性断言（maxHeight: 160、nestedScrollEnabled、overScrollMode、bounces 等）；
// 3. 点击卡片唤起抽屉回调断言（轻触内容区/放大按钮/底栏呼出抽屉、全文展示、字数/耗时呈现、关闭按钮）；
// 4. 仿代码块底色与浅色文字样式断言（canvasDrawer 仿代码块底色、borderRadius: 8、textSecondary 浅色文字）。
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import {
  ReasoningCard,
  ReasoningContentBox,
  REASONING_BOX_MAX_HEIGHT,
  REASONING_CARD_MAX_HEIGHT,
} from './ReasoningCard';
import { ReasoningSheet } from './ReasoningSheet';
import * as clipboardModule from '@/adapters/platform/clipboard';
import { haptics } from '@/adapters/platform/haptics';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function renderCard(element: React.ReactElement) {
  return await render(element, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
    ),
  });
}

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('ReasoningCard 移动端思考链核心交互与呈现', () => {
  describe('1. 完成思考后默认折叠断言', () => {
    it('当 status="done" 时，默认收折为紧凑状态栏，不渲染展开视口', async () => {
      const view = await renderCard(
        <ReasoningCard
          status="done"
          text="这是已完成的长篇思考链内容..."
          durationMs={3200}
        />
      );

      // 视口默认收起
      expect(view.queryByTestId('reasoning-content-box')).toBeNull();
      // 状态行展示紧凑耗时文案与折叠指示
      expect(view.getByText('已深度思考 3 秒')).toBeTruthy();
      expect(view.getByTestId('reasoning-header')).toBeTruthy();
      await view.unmount();
    });

    it('当 block.isThinking=false 时，同样默认收折且支持字数形式文案', async () => {
      const view = await renderCard(
        <ReasoningCard
          block={{
            id: 'r-done-1',
            text: '思考完成文本',
            isThinking: false,
            streaming: false,
          }}
        />
      );

      expect(view.queryByTestId('reasoning-content-box')).toBeNull();
      expect(view.getByText('思考过程 (6 字)')).toBeTruthy();
      await view.unmount();
    });

    it('思考结束但内容为空（或纯空白/零宽字符）时返回 null，不渲染空壳卡片', async () => {
      const view = await renderCard(
        <ReasoningCard status="done" text={'   \u200B\uFEFF '} />
      );
      expect(view.queryByTestId('reasoning-card')).toBeNull();
      expect(view.queryByTestId('reasoning-header')).toBeNull();
      await view.unmount();
    });

    it('正在思考 status="thinking" 保持视口可见；流转为 status="done" 时收拢卸载（无实测高度时即时收折）', async () => {
      const view = await renderCard(
        <ReasoningCard
          status="thinking"
          text="第一步推演中..."
          minResidencyMs={0}
        />
      );

      // 正在思考时保持展开可见
      expect(view.getByTestId('reasoning-content-box')).toBeTruthy();
      expect(view.getByText('正在深度思考...')).toBeTruthy();

      // 状态机翻转为 done：无实测高度（测试环境 onLayout 未触发）→ 即时收折
      await view.rerender(
        <ReasoningCard
          status="done"
          text="第一步推演完成，得到结论。"
          durationMs={4500}
          minResidencyMs={0}
        />
      );

      expect(view.queryByTestId('reasoning-content-box')).toBeNull();
      expect(view.getByText('已深度思考 5 秒')).toBeTruthy();
      await view.unmount();
    });

    it('R9 连续收拢：有实测高度时先保持挂载收拢；收拢中点胶囊中断回到展开', async () => {
      const view = await renderCard(
        <ReasoningCard
          status="thinking"
          text="连续收拢的思考全文。"
          minResidencyMs={0}
        />
      );
      // 模拟实测高度（原生 onLayout）
      await act(async () => {
        fireEvent(view.getByTestId('reasoning-collapse-wrapper'), 'layout', {
          nativeEvent: { layout: { height: 160, width: 340 } },
        });
      });

      await view.rerender(
        <ReasoningCard
          status="done"
          text="连续收拢的思考全文。"
          durationMs={4500}
          minResidencyMs={0}
        />
      );

      // 收拢进行中：内容框仍挂载（高度动画承载负 delta）
      expect(view.queryByTestId('reasoning-content-box')).not.toBeNull();
      // 收拢中点胶囊 → 中断收拢回到展开，内容不丢
      await act(async () => {
        fireEvent.press(view.getByTestId('reasoning-header'));
      });
      expect(view.queryByTestId('reasoning-content-box')).not.toBeNull();
      expect(view.getByText('连续收拢的思考全文。')).toBeTruthy();
      await view.unmount();
    });

    it('思考完成后，用户可手动点击状态栏自由展开与再次收起，并通知脱离跟随', async () => {
      const onToggleDisclosure = jest.fn();
      const disclosureStore = new Map<string, boolean>();

      const view = await renderCard(
        <ReasoningCard
          block={{
            id: 'r-interactive',
            text: '用户可以手动点击查看的思考内容',
            isThinking: false,
            durationMs: 2000,
          }}
          disclosureStore={disclosureStore}
          onToggleDisclosure={onToggleDisclosure}
          minResidencyMs={0}
        />
      );

      // 初始收起
      expect(view.queryByTestId('reasoning-content-box')).toBeNull();

      // 点击展开
      await fireEvent.press(view.getByTestId('reasoning-header'));
      expect(view.getByTestId('reasoning-content-box')).toBeTruthy();
      expect(onToggleDisclosure).toHaveBeenCalledTimes(1);
      expect(disclosureStore.get('r-interactive')).toBe(true);

      // 再次点击收起
      await fireEvent.press(view.getByTestId('reasoning-header'));
      expect(view.queryByTestId('reasoning-content-box')).toBeNull();
      expect(onToggleDisclosure).toHaveBeenCalledTimes(2);
      expect(disclosureStore.get('r-interactive')).toBe(false);
      await view.unmount();
    });
  });

  describe('2. 160dp 限高区域滚动属性断言', () => {
    it('展开状态下容器最大高度为 160dp，且常量契约一致', async () => {
      expect(REASONING_CARD_MAX_HEIGHT).toBe(160);
      expect(REASONING_BOX_MAX_HEIGHT).toBe(160);

      const view = await renderCard(
        <ReasoningCard
          status="thinking"
          text={'长篇思维过程...\n'.repeat(20)}
          minResidencyMs={0}
        />
      );

      const box = view.getByTestId('reasoning-content-box');
      const boxStyle = StyleSheet.flatten(box.props.style);
      expect(boxStyle.maxHeight).toBe(160);
      await view.unmount();
    });

    it('内部 ScrollView 正确配置双端防冲突滚动属性', async () => {
      const view = await renderCard(
        <ReasoningCard
          initialExpanded={true}
          text={'详细论证步骤 1...\n'.repeat(15)}
          minResidencyMs={0}
        />
      );

      const scrollView = view.getByTestId('reasoning-scroll-view');
      // Android 嵌套滚动放行
      expect(scrollView.props.nestedScrollEnabled).toBe(true);
      // 禁止过度滚动波纹
      expect(scrollView.props.overScrollMode).toBe('never');
      // 禁止 iOS 弹性回弹干扰外层
      expect(scrollView.props.bounces).toBe(false);
      // 区域内部滚动使能
      expect(scrollView.props.scrollEnabled).toBe(true);
      expect(scrollView.props.showsVerticalScrollIndicator).toBe(true);
      await view.unmount();
    });

    it('流式思考中内容高度超过 160dp 时随内容事件瞬时落底（无动画重启）', async () => {
      const scrollSpy = jest.fn();
      const protoSpy = jest
        .spyOn(ScrollView.prototype, 'scrollToEnd')
        .mockImplementation(scrollSpy);

      const view = await renderCard(
        <ReasoningContentBox
          text="不断追加的思考文本..."
          isThinking={true}
          onOpenDrawer={() => undefined}
        />
      );

      const scrollView = view.getByTestId('reasoning-scroll-view');
      await act(async () => {
        fireEvent(scrollView, 'contentSizeChange', 350, 220);
      });

      // R9：瞬时落底（animated: false），不是动画重启
      expect(scrollSpy).toHaveBeenCalledWith({ animated: false });
      protoSpy.mockRestore();
      await view.unmount();
    });

    it('R9 高频内容事件逐次瞬时落底（无节流定时器、无动画冲突面）', async () => {
      const scrollSpy = jest.fn();
      const protoSpy = jest
        .spyOn(ScrollView.prototype, 'scrollToEnd')
        .mockImplementation(scrollSpy);

      const view = await renderCard(
        <ReasoningContentBox text="高频生成的思考内容" isThinking={true} />
      );

      const scrollView = view.getByTestId('reasoning-scroll-view');

      await act(async () => {
        const onContentSizeChange = scrollView.props.onContentSizeChange;
        onContentSizeChange(350, 180);
        onContentSizeChange(350, 190);
        onContentSizeChange(350, 200);
        onContentSizeChange(350, 210);
        onContentSizeChange(350, 220);
      });

      // 每次 contentSizeChange 一次瞬时落底；无 trailing 定时器残留
      expect(scrollSpy).toHaveBeenCalledTimes(5);
      expect(scrollSpy).toHaveBeenLastCalledWith({ animated: false });

      protoSpy.mockRestore();
      await view.unmount();
    });

    it('R9 用户拖动立即取消跟随：拖动后内容增长不再抢读', async () => {
      const scrollSpy = jest.fn();
      const protoSpy = jest
        .spyOn(ScrollView.prototype, 'scrollToEnd')
        .mockImplementation(scrollSpy);

      const view = await renderCard(
        <ReasoningContentBox text="拖动取消跟随" isThinking={true} />
      );
      const scrollView = view.getByTestId('reasoning-scroll-view');

      await act(async () => {
        fireEvent(scrollView, 'contentSizeChange', 350, 220);
      });
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent(scrollView, 'scrollBeginDrag');
      });
      await act(async () => {
        fireEvent(scrollView, 'contentSizeChange', 350, 300);
      });
      // 拖动后不再自动落底（阅读历史不抢读）
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      protoSpy.mockRestore();
      await view.unmount();
    });

    it('R9 上滑阅读后跟随解除，回到底部自动恢复', async () => {
      const scrollSpy = jest.fn();
      const protoSpy = jest
        .spyOn(ScrollView.prototype, 'scrollToEnd')
        .mockImplementation(scrollSpy);

      const view = await renderCard(
        <ReasoningContentBox text="上滑阅读恢复跟随" isThinking={true} />
      );
      const scrollView = view.getByTestId('reasoning-scroll-view');

      await act(async () => {
        fireEvent(scrollView, 'contentSizeChange', 350, 220);
      });
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      // 用户上滑（离底 100dp）→ 脱离跟随
      await act(async () => {
        fireEvent(scrollView, 'scroll', {
          nativeEvent: {
            contentSize: { height: 300, width: 350 },
            contentOffset: { x: 0, y: 0 },
            layoutMeasurement: { height: 160, width: 350 },
          },
        });
      });
      await act(async () => {
        fireEvent(scrollView, 'contentSizeChange', 350, 320);
      });
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      // 回到底部（离底 <40dp）→ 恢复跟随
      await act(async () => {
        fireEvent(scrollView, 'scroll', {
          nativeEvent: {
            contentSize: { height: 320, width: 350 },
            contentOffset: { x: 0, y: 130 },
            layoutMeasurement: { height: 160, width: 350 },
          },
        });
      });
      await act(async () => {
        fireEvent(scrollView, 'contentSizeChange', 350, 340);
      });
      expect(scrollSpy).toHaveBeenCalledTimes(2);

      protoSpy.mockRestore();
      await view.unmount();
    });

    it('ReasoningCard 经 React.memo 包裹导出', () => {
      expect((ReasoningCard as any).$$typeof).toBe(Symbol.for('react.memo'));
    });
  });

  describe('3. 纯净思考卡片交互与抽屉解耦断言', () => {
    it('展开状态下不渲染多余的顶部标签与抽屉按钮，抽屉默认不挂载', async () => {
      const view = await renderCard(
        <ReasoningCard
          initialExpanded={true}
          text="这是纯净的思考推演过程。"
          durationMs={4800}
          minResidencyMs={0}
        />
      );

      expect(view.queryByTestId('reasoning-drawer-btn')).toBeNull();
      expect(view.queryByTestId('reasoning-box-toolbar')).toBeNull();
      expect(view.queryByTestId('reasoning-expand-sheet-bar')).toBeNull();
      expect(view.queryByTestId('reasoning-sheet')).toBeNull();
      await view.unmount();
    });

    it('抽屉独立组件仍然具备完整全文、耗时标签、字数统计并支持点击完成阅读关闭', async () => {
      const onClose = jest.fn();
      const view = await renderCard(
        <ReasoningSheet
          visible={true}
          onClose={onClose}
          text="深度推演长文，包含多步分析。"
          durationMs={4000}
        />
      );

      expect(view.getByTestId('reasoning-sheet')).toBeTruthy();
      expect(view.getByTestId('reasoning-sheet-text')).toBeTruthy();
      expect(view.getByText('深度推演长文，包含多步分析。')).toBeTruthy();
      expect(view.getByText('耗时 4 秒')).toBeTruthy();
      expect(view.getByText('字数 14 字')).toBeTruthy();

      // 点击完成阅读按钮
      await fireEvent.press(view.getByTestId('reasoning-sheet-close-btn'));
      expect(onClose).toHaveBeenCalledTimes(1);
      await view.unmount();
    });

    it('抽屉内点击“复制思考内容”调用剪贴板并触发触感反馈', async () => {
      const copySpy = jest
        .spyOn(clipboardModule, 'copyTextToClipboard')
        .mockResolvedValue(true);
      const hapticsSpy = jest
        .spyOn(haptics, 'selection')
        .mockImplementation(() => {});

      const view = await renderCard(
        <ReasoningSheet
          visible={true}
          onClose={() => undefined}
          text="待复制的思考内容"
        />
      );

      await fireEvent.press(view.getByTestId('reasoning-sheet-copy-btn'));

      expect(copySpy).toHaveBeenCalledWith('待复制的思考内容');
      expect(hapticsSpy).toHaveBeenCalledTimes(1);
      await view.unmount();
    });
  });

  describe('4. 纯白底色与浅色文字样式断言', () => {
    it('容器采用纯白底色 (surface #ffffff) 与微圆角 (borderRadius: 12)', async () => {
      const view = await renderCard(
        <ReasoningCard
          initialExpanded={true}
          text="样式校验样本"
          minResidencyMs={0}
        />
      );

      const box = view.getByTestId('reasoning-content-box');
      const boxStyle = StyleSheet.flatten(box.props.style);

      // 纯白底色（轻浅模式下为 #ffffff）
      expect(boxStyle.backgroundColor).toBe('#ffffff');
      // 微圆角规范（theme.radius.control）
      expect(boxStyle.borderRadius).toBe(12);
      // 任务四 B：展开盒无描边（去 borderWidth），只靠纯白底与圆角分层
      expect(boxStyle.borderWidth).toBeUndefined();
      await view.unmount();
    });

    it('思考正文文字采用偏浅次级色阶 (textSecondary)，与主回答正文清晰拉开反差', async () => {
      const view = await renderCard(
        <ReasoningCard
          initialExpanded={true}
          text="浅色文字色阶校验"
          minResidencyMs={0}
        />
      );

      // 任务四 B：正文经 MarkdownText 渲染，段落文字节点即正文基线载体
      const textNode = view.getByText('浅色文字色阶校验');
      const textStyle = StyleSheet.flatten(textNode.props.style);

      // textSecondary 为 #555555（浅色模式下次级灰色，与 textPrimary #171717 形成反差）
      expect(textStyle.color).toBe('#555555');
      // 基线 footnote（13）：比正文 chat（14）小一档，且不再叠等宽字
      expect(textStyle.fontSize).toBe(13);
      await view.unmount();
    });

    it('抽屉内部展示盒保持 canvasDrawer 仿代码块质感与 textSecondary 浅色文字', async () => {
      const view = await renderCard(
        <ReasoningSheet
          visible={true}
          onClose={() => undefined}
          text="抽屉内部文本"
        />
      );

      const sheetBox = view.getByTestId('reasoning-sheet-box');
      const boxStyle = StyleSheet.flatten(sheetBox.props.style);
      expect(boxStyle.backgroundColor).toBe('#f0f0f0');
      expect(boxStyle.borderRadius).toBe(12);

      const sheetText = view.getByTestId('reasoning-sheet-text');
      const textStyle = StyleSheet.flatten(sheetText.props.style);
      expect(textStyle.color).toBe('#555555');
      await view.unmount();
    });
  });
});

describe('ReasoningCard · 任务四 B 行样式与思考 Markdown', () => {
  it('状态行无描边且标签字号为 callout（14，非 caption 12.5）', async () => {
    const view = await renderCard(
      <ReasoningCard
        status="done"
        text="行样式校验样本"
        durationMs={2000}
        minResidencyMs={0}
      />
    );

    const header = view.getByTestId('reasoning-header');
    const headerStyle = StyleSheet.flatten(header.props.style);
    expect(headerStyle.borderWidth).toBeUndefined();

    const label = view.getByTestId('reasoning-header-label');
    const labelStyle = StyleSheet.flatten(label.props.style);
    expect(labelStyle.fontSize).toBe(14);
    await view.unmount();
  });

  it('展开正文 Markdown 化：列表成形、行内代码不带反引号原文', async () => {
    const view = await renderCard(
      <ReasoningCard
        initialExpanded={true}
        text={'先列要点：\n\n- 第一项\n- 第二项\n\n结论含 `inlineCode` 片段。'}
        minResidencyMs={0}
      />
    );

    expect(view.getByText('第一项')).toBeTruthy();
    expect(view.getByText('第二项')).toBeTruthy();
    // 原文符号不直出（旧纯文本呈现会把整段当一个字符串原样显示）
    expect(view.queryByText(/- 第一项/)).toBeNull();
    expect(view.queryByText(/`inlineCode`/)).toBeNull();
    expect(view.getByText(/inlineCode/)).toBeTruthy();
    await view.unmount();
  });

  it('流式两帧：先行段保持成形，尾段继续生长不整段回原文', async () => {
    const frame1 = '第一段推演已经成形。\n\n- 要点甲\n- 要点乙';
    const view = await renderCard(
      <ReasoningCard status="thinking" text={frame1} minResidencyMs={0} />
    );
    expect(view.getByText('第一段推演已经成形。')).toBeTruthy();
    expect(view.getByText('要点甲')).toBeTruthy();

    await view.rerender(
      <ReasoningCard
        status="thinking"
        text={frame1 + '\n\n尾段继续生长中'}
        minResidencyMs={0}
      />
    );
    // 已成形段与列表项保持结构，尾段新内容到场（封口复用机制在
    // MarkdownText 套件有解析级断言，此处锁卡片级行为）
    expect(view.getByText('第一段推演已经成形。')).toBeTruthy();
    expect(view.getByText('要点乙')).toBeTruthy();
    expect(view.getByText('尾段继续生长中')).toBeTruthy();
    await view.unmount();
  });
});
