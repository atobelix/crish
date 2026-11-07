// Composer 测试：输入回调与发送可用态。
import { Keyboard, Platform, StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Gesture } from 'react-native-gesture-handler';
import {
  darkTheme,
  lightTheme,
  resetThemeModeForTest,
  setThemeMode,
} from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import { Composer } from '@/presentation/ui';
import {
  DEFAULT_COMPOSER_PLACEHOLDER,
  inputVoiceGestureEnabled,
} from '@/presentation/ui/Composer';
import type { VoiceInputApi } from '@/adapters/asr/useVoiceInput';

const fakeVoice: VoiceInputApi = {
  phase: 'idle',
  starting: false,
  displayText: '',
  level: 0,
  error: null,
  recover: jest.fn(),
  dismissError: jest.fn(),
  gateState: null,
  gateVisible: false,
  modelTotalBytes: 240193589,
  pressStart: jest.fn(),
  pressMove: jest.fn(),
  pressEnd: jest.fn(),
  confirmDownload: jest.fn(),
  dismissGate: jest.fn(),
};

function renderComposer(canSubmit: boolean) {
  const onSubmit = jest.fn();
  const onChangeText = jest.fn();
  const element = (
    <Composer
      testID="composer"
      value={canSubmit ? '跑测试' : ''}
      placeholder="给电脑发一条指令"
      onChangeText={onChangeText}
      onSubmit={onSubmit}
      canSubmit={canSubmit}
      editable
    />
  );
  return { element, onSubmit, onChangeText };
}

describe('Composer', () => {
  it('forwards text and blocks submit when not allowed', async () => {
    const { element, onSubmit, onChangeText } = renderComposer(false);
    const view = await render(element);
    await fireEvent.changeText(view.getByTestId('composer'), '跑测试');
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(onChangeText).toHaveBeenCalledWith('跑测试');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits when allowed', async () => {
    const { element, onSubmit } = renderComposer(true);
    const view = await render(element);
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('R6 发送只震一次：按压处不发任何触感（受理语义触觉由 VM 受理点发声）', async () => {
    const taps = [
      jest.spyOn(haptics, 'tap'),
      jest.spyOn(haptics, 'success'),
      jest.spyOn(haptics, 'failure'),
      jest.spyOn(haptics, 'snap'),
      jest.spyOn(haptics, 'selection'),
    ];
    const { element } = renderComposer(true);
    const view = await render(element);
    await fireEvent.press(view.getByTestId('composer-send'));
    for (const spy of taps) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('renders no microphone without the voice wiring (honest absence)', async () => {
    const { element } = renderComposer(false);
    const view = await render(element);
    expect(view.queryByTestId('composer-mic')).toBeNull();
  });

  it('G1 快捷条：注入 contextBar 时渲染项目/权限胶囊并回调，未注入则不渲染', async () => {
    const onWorkspacePress = jest.fn();
    const onPermissionPress = jest.fn();
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        contextBar={{
          workspaceLabel: 'conex',
          permissionLabel: '智能放行',
          onWorkspacePress,
          onPermissionPress,
        }}
      />
    );
    expect(view.getByText('conex')).toBeTruthy();
    expect(view.getByText('智能放行')).toBeTruthy();
    await fireEvent.press(view.getByTestId('composer-workspace'));
    await fireEvent.press(view.getByTestId('composer-permission'));
    expect(onWorkspacePress).toHaveBeenCalledTimes(1);
    expect(onPermissionPress).toHaveBeenCalledTimes(1);

    const { element } = renderComposer(false);
    const plain = await render(element);
    expect(plain.queryByTestId('composer-workspace')).toBeNull();
    expect(plain.queryByTestId('composer-permission')).toBeNull();
    expect(plain.queryByTestId('composer-model')).toBeNull();
  });

  it('第二行模型钮：注入 model 时恒在（标签 + 点击回调，无需聚焦）', async () => {
    const onPress = jest.fn();
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        model={{ label: '默认模型', onPress }}
      />
    );
    expect(view.getByText('默认模型')).toBeTruthy();
    // 恒两行形态（2026-11-03）：第二行不待聚焦展开，未聚焦即可点
    await fireEvent.press(view.getByTestId('composer-model'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('G5b 纯附件可发：无文字 + hasAttachments 时右槽出发送盘并可提交；未注入则不出', async () => {
    const onSubmit = jest.fn();
    const withAttachments = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={onSubmit}
        canSubmit
        editable
        hasAttachments
      />
    );
    await fireEvent.press(withAttachments.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const without = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit
        editable
      />
    );
    expect(without.queryByTestId('composer-send')).toBeNull();
  });

  it('语音接线时也不渲染麦克风钮（2026-11-03 删除）：长按输入为唯一语音入口', async () => {
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        voice={fakeVoice}
      />
    );
    expect(view.queryByTestId('composer-mic')).toBeNull();
    // 有文字时同样无麦克风（右槽为发送盘）
    const withText = await render(
      <Composer
        testID="composer"
        value="已有文字"
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit
        editable
        voice={fakeVoice}
      />
    );
    expect(withText.queryByTestId('composer-mic')).toBeNull();
  });
});

/** 几何断言辅助：沿渲染树上溯，取首个命中谓词的祖先节点摊平样式 */
interface StyleNode {
  props: { style?: unknown };
  parent: StyleNode | null;
}

function flatStyle(node: StyleNode): Record<string, unknown> {
  return (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<
    string,
    unknown
  >;
}

function findAncestorStyle(
  node: StyleNode,
  predicate: (style: Record<string, unknown>) => boolean
): Record<string, unknown> {
  let cur: StyleNode | null = node.parent;
  while (cur) {
    const style = flatStyle(cur);
    if (predicate(style)) return style;
    cur = cur.parent;
  }
  throw new Error('ancestor style not found');
}

describe('Composer 几何（原型 composer.css 对齐 + 2026-11-03 校准）', () => {
  it('无第二行卡：minHeight 52 / 圆角 30 / 横内距 10 / 上下 8 / 内容垂直居中 / 描边 1px borderStrong', async () => {
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        voice={fakeVoice}
        onAttachPress={jest.fn()}
      />
    );
    const shell = findAncestorStyle(
      view.getByTestId('composer') as unknown as StyleNode,
      (s) => s.borderRadius === 26 || s.borderRadius === 30
    );
    expect(shell.minHeight).toBe(52);
    expect(shell.paddingHorizontal).toBe(10);
    expect(shell.paddingVertical).toBe(8);
    // 余量上下均分，不沉底
    expect(shell.justifyContent).toBe('center');
    // 描边（2026-11-03 降重调优）：1px 极柔微描边（浅色 rgba(0,0,0,0.025) 融于背景）
    expect(shell.borderWidth).toBe(1);
    expect(shell.borderColor).toBe('rgba(0, 0, 0, 0.025)');
  });

  it('首行同中线：输入包裹托底 36（= 发送盘直径）+ 字形剔除字体附加内距 + 工具钮盒高 36', async () => {
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        onAttachPress={jest.fn()}
      />
    );
    const inputNode = view.getByTestId('composer') as unknown as StyleNode;
    // 输入包裹 minHeight 36：单行时文本在 36 盒内居中，中线与发送盘同线
    const inputWrap = findAncestorStyle(inputNode, (s) => s.minHeight === 36);
    expect(inputWrap.minHeight).toBe(36);
    // 字形按行高盒精确定心（includeFontPadding false）
    expect(flatStyle(inputNode).includeFontPadding).toBe(false);
    // 工具钮盒高 36（宽 32 不变）：图标居中后中线与发送盘一致
    const attachStyle = flatStyle(
      view.getByLabelText('添加附件') as unknown as StyleNode
    );
    expect(attachStyle.width).toBe(32);
    expect(attachStyle.height).toBe(36);
  });

  it('快捷条：左 14 + 胶囊内距 2 = 16 与 ＋ 图标左缘零误差对齐；右 16 / 下距 5 / 条间距 12 / 胶囊高 22', async () => {
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        contextBar={{
          workspaceLabel: 'conex',
          permissionLabel: '智能放行',
          onWorkspacePress: jest.fn(),
          onPermissionPress: jest.fn(),
        }}
      />
    );
    const capsule = view.getByTestId(
      'composer-workspace'
    ) as unknown as StyleNode;
    const capsuleStyle = flatStyle(capsule);
    expect(capsuleStyle.height).toBe(22);
    expect(capsuleStyle.paddingHorizontal).toBe(2);
    const bar = flatStyle(capsule.parent as StyleNode);
    expect(bar.flexDirection).toBe('row');
    expect(bar.gap).toBe(12);
    expect(bar.paddingLeft).toBe(14);
    expect(bar.paddingRight).toBe(16);
    expect(bar.paddingBottom).toBe(5);
    // 对齐不变量：胶囊图标左缘（相对卡左缘）= 条左距 + 胶囊内距 = 16，
    // 与卡内 ＋ 图标左缘（内距 10 + (32 − 20) / 2 = 16）同值
    expect(
      (bar.paddingLeft as number) + (capsuleStyle.paddingHorizontal as number)
    ).toBe(16);
  });

  it('第二行（恒两行，未聚焦即在位）：卡上下边距 10 + 首行托底 36 + 行距 6 + 次行 36（合计 98）；右侧动作簇间距 10；模型钮内距 4；无麦克风', async () => {
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        voice={fakeVoice}
        onAttachPress={jest.fn()}
        model={{ label: '默认模型', onPress: jest.fn() }}
      />
    );
    const inputNode = view.getByTestId('composer') as unknown as StyleNode;
    const shell = findAncestorStyle(
      inputNode,
      (s) => s.borderRadius === 26 || s.borderRadius === 30
    );
    // 未聚焦即两行形态：上下边距直接为 10（无展开过程）
    expect(shell.paddingVertical).toBe(10);
    const inputWrap = findAncestorStyle(inputNode, (s) => s.minHeight === 36);
    expect(inputWrap.minHeight).toBe(36);
    const row = findAncestorStyle(
      view.getByTestId('composer-model') as unknown as StyleNode,
      (s) => s.height === 36 && s.marginTop === 6
    );
    expect(row.height).toBe(36);
    expect(row.marginTop).toBe(6);
    const actions = findAncestorStyle(
      view.getByLabelText('添加附件') as unknown as StyleNode,
      (s) => s.flexDirection === 'row' && s.gap === 10
    );
    expect(actions.gap).toBe(10);
    const modelStyle = flatStyle(
      view.getByTestId('composer-model') as unknown as StyleNode
    );
    expect(modelStyle.height).toBe(28);
    expect(modelStyle.paddingHorizontal).toBe(4);
    // 第二行右侧簇只有附件钮：麦克风已删除
    expect(view.queryByTestId('composer-mic')).toBeNull();
  });

  it('语音手势启用彻底解耦 editable：仅依赖 voicePresent 与 !locked', () => {
    // 核心契约（方案 01 对齐）：即使 editable=false（如远端尚未连接或离线状态），长按语音手势必须保持启用！
    expect(
      inputVoiceGestureEnabled({ voicePresent: true, locked: false })
    ).toBe(true);

    // 缺失语音链路时禁用
    expect(
      inputVoiceGestureEnabled({ voicePresent: false, locked: false })
    ).toBe(false);

    // 审批锁定态（locked=true）强行禁用
    expect(inputVoiceGestureEnabled({ voicePresent: true, locked: true })).toBe(
      false
    );

    // 即使传入 editable: false，长按手势亦保持启用
    expect(
      inputVoiceGestureEnabled({
        voicePresent: true,
        locked: false,
        editable: false,
      })
    ).toBe(true);
  });

  it('DOM 拓扑契约：透明分流层必须位于 TextInput 之上并绝对铺满 (absoluteFillObject)', async () => {
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable={false} // 模拟离线
        voice={fakeVoice}
      />
    );

    // 1. 验证透明拦截层挂载
    const overlay = view.getByTestId('composer-voice-touch-overlay');
    expect(overlay).toBeTruthy();

    // 2. 验证样式为 absoluteFillObject
    const flattenedStyle = StyleSheet.flatten(overlay.props.style);
    expect(flattenedStyle?.position).toBe('absolute');
    expect(flattenedStyle.top).toBe(0);
    expect(flattenedStyle.left).toBe(0);
    expect(flattenedStyle.right).toBe(0);
    expect(flattenedStyle.bottom).toBe(0);

    // 3. 未聚焦时 pointerEvents 必须为 'auto'
    expect(overlay.props.pointerEvents).toBe('auto');

    // 4. 输入框包裹层结构正常
    const inputNode = view.getByTestId('composer') as unknown as StyleNode;
    const wrap = findAncestorStyle(inputNode, (s) => s.minHeight === 36);
    expect(wrap.flex).toBe(1);
  });

  it('长按手势构造计数：启用单值不变则逐键重渲染零重建；翻转（locked）才重建（C-PERF 记忆化 + 翻转换装双钉）', async () => {
    const simultaneous = jest.spyOn(Gesture, 'Simultaneous');
    try {
      const baseProps = {
        testID: 'composer',
        placeholder: '给电脑发一条指令',
        onChangeText: jest.fn(),
        onSubmit: jest.fn(),
        canSubmit: false,
        voice: fakeVoice,
      } as const;
      const view = await render(<Composer {...baseProps} value="" editable />);
      const afterMount = simultaneous.mock.calls.length;
      expect(afterMount).toBeGreaterThan(0);
      await view.rerender(<Composer {...baseProps} value="打" editable />);
      await view.rerender(<Composer {...baseProps} value="打字" editable />);
      expect(simultaneous.mock.calls.length).toBe(afterMount);
      await view.rerender(
        <Composer {...baseProps} value="打字" editable locked={true} />
      );
      expect(simultaneous.mock.calls.length).toBe(afterMount + 1);
    } finally {
      simultaneous.mockRestore();
    }
  });

  it('长按激活契约：到达 200ms 瞬间必须触发 haptics.snap 并收起键盘', async () => {
    const snapSpy = jest.spyOn(haptics, 'snap');
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss');
    let capturedOnStart: (() => void) | undefined;
    const origLongPress = Gesture.LongPress;
    jest.spyOn(Gesture, 'LongPress').mockImplementation(() => {
      const builder = origLongPress();
      const origOnStart = builder.onStart.bind(builder);
      builder.onStart = (cb: any) => {
        capturedOnStart = cb;
        return origOnStart(cb);
      };
      return builder;
    });

    try {
      await render(
        <Composer
          testID="composer"
          value=""
          onChangeText={jest.fn()}
          onSubmit={jest.fn()}
          canSubmit={false}
          editable
          voice={fakeVoice}
        />
      );
      expect(capturedOnStart).toBeDefined();
      capturedOnStart!();
      expect(snapSpy).toHaveBeenCalledTimes(1);
      expect(dismissSpy).toHaveBeenCalledTimes(1);
      expect(fakeVoice.pressStart).toHaveBeenCalledTimes(1);
    } finally {
      snapSpy.mockRestore();
      dismissSpy.mockRestore();
      jest.restoreAllMocks();
    }
  });

  it('语音未就绪（引擎硬错误在场）时长按手势照常装配：启用只问功能在场，启动失败落错误面、永不以禁用手势退化成选字', async () => {
    const simultaneous = jest.spyOn(Gesture, 'Simultaneous');
    try {
      const view = await render(
        <Composer
          testID="composer"
          value="已有文字"
          placeholder="给电脑发一条指令"
          onChangeText={jest.fn()}
          onSubmit={jest.fn()}
          canSubmit
          editable
          voice={{
            ...fakeVoice,
            error: { message: '语音引擎启动失败', recovery: 'retry-init' },
          }}
        />
      );
      // 手势已构造（在场），且硬错误走错误条呈现——两条面互不牵连
      expect(simultaneous.mock.calls.length).toBeGreaterThan(0);
      expect(view.getByTestId('voice-error-bar')).toBeTruthy();
    } finally {
      simultaneous.mockRestore();
    }
  });

  it('语音错误条：硬错误常驻呈现并带根因恢复动作，可关闭；无错误不渲染', async () => {
    const recover = jest.fn();
    const dismissError = jest.fn();
    const view = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        voice={{
          ...fakeVoice,
          error: { message: '语音引擎启动失败', recovery: 'retry-init' },
          recover,
          dismissError,
        }}
      />
    );
    expect(view.getByTestId('voice-error-bar')).toBeTruthy();
    expect(view.getByText('语音引擎启动失败')).toBeTruthy();
    await fireEvent.press(view.getByTestId('voice-error-recover'));
    expect(recover).toHaveBeenCalledTimes(1);
    await fireEvent.press(view.getByTestId('voice-error-dismiss'));
    expect(dismissError).toHaveBeenCalledTimes(1);

    const plain = await render(
      <Composer
        testID="composer"
        value=""
        placeholder="给电脑发一条指令"
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        voice={fakeVoice}
      />
    );
    expect(plain.queryByTestId('voice-error-bar')).toBeNull();
  });

  it('缺省提示文案为「点击发消息、长按语音输入」', async () => {
    const view = await render(
      <Composer
        testID="composer"
        value=""
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
      />
    );
    expect(view.getByTestId('composer').props.placeholder).toBe(
      DEFAULT_COMPOSER_PLACEHOLDER
    );
    expect(DEFAULT_COMPOSER_PLACEHOLDER).toBe('点击发消息、长按语音输入');
  });

  it('启用语音手势时禁用 TextInput 原生上下文菜单（contextMenuHidden）以防剪贴板长按劫持', async () => {
    const withVoice = await render(
      <Composer
        testID="composer"
        value=""
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
        voice={fakeVoice}
      />
    );
    expect(withVoice.getByTestId('composer').props.contextMenuHidden).toBe(
      true
    );

    const withoutVoice = await render(
      <Composer
        testID="composer"
        value=""
        onChangeText={jest.fn()}
        onSubmit={jest.fn()}
        canSubmit={false}
        editable
      />
    );
    expect(withoutVoice.getByTestId('composer').props.contextMenuHidden).toBe(
      false
    );
  });

  it('手势采用 Exclusive 组合短按聚焦与长按录音', async () => {
    const exclusive = jest.spyOn(Gesture, 'Exclusive');
    try {
      await render(
        <Composer
          testID="composer"
          value=""
          onChangeText={jest.fn()}
          onSubmit={jest.fn()}
          canSubmit={false}
          editable
          voice={fakeVoice}
        />
      );
      expect(exclusive).toHaveBeenCalled();
    } finally {
      exclusive.mockRestore();
    }
  });

  describe('Composer 纯白质感与结构断言（方案 12 钉案）', () => {
    const originalOS = Platform.OS;

    afterEach(async () => {
      jest.replaceProperty(Platform, 'OS', originalOS);
      await act(async () => {
        resetThemeModeForTest();
      });
    });

    it('浅色模式输入框外壳纯白实体断言：backgroundColor 严格为 surface (#ffffff)，overflow 为 visible，内部无 BlurView', async () => {
      await act(async () => {
        setThemeMode('light');
      });
      const { element } = renderComposer(false);
      const view = await render(element);
      const shell = view.getByTestId('composer-shell');
      const flat = StyleSheet.flatten(shell.props.style);

      expect(flat.backgroundColor).toBe(lightTheme.colors.surface);
      expect(flat.overflow).toBe('visible');
      expect(view.queryByTestId('composer-blur')).toBeNull();
    });

    it('iOS 浅色隔离断言：Mock Platform.OS = ios，浅色模式下不渲染 BlurView，backgroundColor 依然保持 surface', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await act(async () => {
        setThemeMode('light');
      });
      const { element } = renderComposer(false);
      const view = await render(element);
      const shell = view.getByTestId('composer-shell');
      const flat = StyleSheet.flatten(shell.props.style);

      expect(flat.backgroundColor).toBe(lightTheme.colors.surface);
      expect(flat.overflow).toBe('visible');
      expect(view.queryByTestId('composer-blur')).toBeNull();
    });

    it('iOS 深色模式激活 glassActive：渲染 BlurView，backgroundColor 为 surfaceTranslucent', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await act(async () => {
        setThemeMode('dark');
      });
      const { element } = renderComposer(false);
      const view = await render(element);
      const shell = view.getByTestId('composer-shell');
      const flat = StyleSheet.flatten(shell.props.style);

      expect(flat.backgroundColor).toBe(darkTheme.colors.surfaceTranslucent);
      expect(flat.overflow).toBe('hidden');
      expect(view.getByTestId('composer-blur')).toBeTruthy();
    });

    it('Android 软阴影挂载断言：Mock Platform.OS = android，layout 后以 variant="composer" 挂载 SoftShadow', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await act(async () => {
        setThemeMode('light');
      });
      const { element } = renderComposer(false);
      const view = await render(element);
      const shell = view.getByTestId('composer-shell');

      // 触发 layout 事件以提交尺寸并挂载 SoftShadow
      await act(async () => {
        fireEvent(shell, 'layout', {
          nativeEvent: { layout: { width: 360, height: 52 } },
        });
      });

      // 验证渲染树包含 SoftShadow 的 SVG 节点
      const rootJson = JSON.stringify(view.toJSON());
      expect(rootJson).toContain('soft-shadow');
      expect(view.queryByTestId('composer-blur')).toBeNull();
    });
  });
});
