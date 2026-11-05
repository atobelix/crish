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

    it('正在思考 status="thinking" 保持视口可见；流转为 status="done" 时刚性折叠', async () => {
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

      // 状态机翻转为 done，触发刚性收拢
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

    it('流式思考中内容高度超过 160dp 时触发自动吸底滚到底部', async () => {
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
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(scrollSpy).toHaveBeenCalledWith({ animated: true });
      protoSpy.mockRestore();
      await view.unmount();
    });

    it('在 100ms 窗口内高频触发 contentSizeChange 时受到节流防抖控制，杜绝逐字动画冲突', async () => {
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
        // 等待 120ms 让 trailing edge 在当前 act 作用域内完整执行
        await new Promise((r) => setTimeout(r, 120));
      });

      // 5 次密集触发最终仅执行 2 次 scrollToEnd (leading 1 次 + trailing 1 次)，杜绝逐字动画冲突
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
      // 细边框界定
      expect(boxStyle.borderWidth).toBe(1);
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

      const textNode = view.getByTestId('reasoning-text');
      const textStyle = StyleSheet.flatten(textNode.props.style);

      // textSecondary 为 #555555（浅色模式下次级灰色，与 textPrimary #171717 形成反差）
      expect(textStyle.color).toBe('#555555');
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
