/**
 * ui/internal/layer-stack/LayerStackService.ts
 *
 * 浮层栈与事件隔离单例中枢 —— ui/ 原子层内部私有实现（全仓唯一实装）。
 *
 * 由来：原 `src/services/LayerStackService.ts` 被 ui 原子层（Dialog/Menu）经
 * `src/hooks/useLayerRegistration.ts` 反向依赖，违反原子层门禁。按详案 F1-α
 * 将服务**无副作用下沉**为 ui/ 内部私有（`ui/internal/**` 视为 ui 自身，门禁放行），
 * 使 ui/ 内部 hook 不再 import `src/services/`。
 *
 * 说明：详案命名的"最小子集"（register/registerVirtual + 单例 + 类型）与类内部
 * 实现（layers 栈 / 全局监听 / Trace / 焦点还原 / 级联关闭）不可分割，故保留完整
 * 类实现以保证行为零漂移；对外仅暴露原子层所需调用面。
 * 原 `src/services/LayerStackService.ts` 死副本及其陪葬测试 `LayerStackService.test.ts`
 * 已按主控裁决删除（生产零消费，收敛为单 canonical 实现）。
 */

export type LayerType =
  | 'modal-dialog' // 全局模态弹窗（SettingsPanel, SkillEditorModal, FirstRunWizard）
  | 'confirm-dialog' // 二次确认对话框（ConfirmDialog, WithdrawConfirmDialog）
  | 'drawer' // 抽屉浮层（ChatStatusRibbons, PlanDrawer）
  | 'context-menu' // 右键上下文菜单（SessionContextMenu, SidebarMenu）
  | 'dropdown-menu' // 下拉菜单（Menu, Select, ModelPicker）
  | 'cascade-submenu' // 级联二级子菜单（ContextMenuFlyout, Submenu）
  | 'popover' // 普通气泡（TiptapSlashMenu, Popover）
  | 'tooltip' // 悬浮提示（Tooltip）
  | 'toast' // 全局通知（ToastStack）
  | 'virtual-interceptor'; // 虚拟拦截器（快捷键录制态、分屏拖拽态）

export type DismissReason =
  | 'escape' // 按下 Esc 键退出
  | 'outside-pointer' // 点击外部区域退出
  | 'item-select' // 选中菜单项退出
  | 'programmatic' // 代码显式命令式调用退出
  | 'parent-dismissed'; // 父层被销毁导致级联关闭

export interface LayerRegistration {
  /** 唯一标识 */
  id: string;
  /** 浮层语义类型 */
  type: LayerType;
  /** 父浮层 ID（用于三层级联拓扑追踪） */
  parentId?: string;
  /** 浮层容器的 DOM 引用（虚拟拦截层为 undefined） */
  elementRef?: React.RefObject<HTMLElement | null> | HTMLElement | null;
  /** 挂载的 Portal 容器节点 */
  portalContainer?: HTMLElement | null;
  /** 关联的触发源节点（用于外点判定豁免与焦点还原） */
  anchorRef?: React.RefObject<HTMLElement | null> | HTMLElement | null;
  /** 是否允许通过 Esc / 外点关闭 */
  dismissible: boolean;
  /** 是否为模态层（阻断外部交互） */
  modal?: boolean;
  /** 显式指定的焦点还原目标 */
  restoreFocusTarget?: HTMLElement | null;
  /** 浮层关闭回调 */
  onDismiss: (reason: DismissReason) => void;
  /**
   * Esc 键盘按下时的定制钩子
   * @returns true 表示浮层内部已消费此事件（如子状态回退、快捷键录制），中枢不执行默认 onDismiss
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => boolean | void;
  /**
   * 外点交互按下时的定制钩子
   * @returns true 表示拦截外点关闭
   */
  onPointerDownOutside?: (event: PointerEvent) => boolean | void;
  /** 注册时间戳（用于稳定排序与 Trace 审计） */
  mountedAt: number;
}

export interface LayerTraceRecord {
  id: string;
  type: LayerType;
  parentId?: string;
  mountedAt: number;
  dismissedAt: number;
  dismissReason: DismissReason;
}

const LAYER_TYPE_PRIORITY: Record<LayerType, number> = {
  'modal-dialog': 10,
  'confirm-dialog': 15,
  drawer: 20,
  popover: 30,
  'dropdown-menu': 40,
  'context-menu': 40,
  'cascade-submenu': 50,
  tooltip: 60,
  toast: 70,
  'virtual-interceptor': 100,
};

const PROCESSED_EVENTS = new WeakSet<Event>();

export class LayerStackService {
  private static instance: LayerStackService | null = null;
  private static readonly MAX_TRACE_HISTORY = 100;

  private layers: LayerRegistration[] = [];
  private traceHistory: LayerTraceRecord[] = [];
  private isListening = false;
  private lastEscapeDismissTime = 0;

  private sequence = 0;

  private constructor() {
    this.attachGlobalListeners();
  }

  /**
   * 获取全局单例实例
   */
  public static getInstance(): LayerStackService {
    if (!LayerStackService.instance) {
      LayerStackService.instance = new LayerStackService();
    }
    return LayerStackService.instance;
  }

  /**
   * 注册浮层实例，返回注销函数
   */
  public register(layer: Omit<LayerRegistration, 'mountedAt'>): () => void {
    this.attachGlobalListeners();
    const fullLayer: LayerRegistration = {
      ...layer,
      mountedAt: ++this.sequence,
    };

    // 避免重复 ID 污染
    this.layers = this.layers.filter((l) => l.id !== fullLayer.id);
    this.layers.push(fullLayer);

    // 按层级权重稳定排序（相同权重保持 mountedAt 注册入栈顺序）
    this.layers.sort((a, b) => {
      const pA = LAYER_TYPE_PRIORITY[a.type] ?? 0;
      const pB = LAYER_TYPE_PRIORITY[b.type] ?? 0;
      if (pA !== pB) return pA - pB;
      return a.mountedAt - b.mountedAt;
    });

    return () => {
      this.unregister(fullLayer.id);
    };
  }

  /**
   * 注册临时虚拟拦截器（如快捷键录制态）
   */
  public registerVirtual(
    id: string,
    onEscape: (e: KeyboardEvent) => boolean | void,
    onDismiss?: (reason: DismissReason) => void
  ): () => void {
    return this.register({
      id,
      type: 'virtual-interceptor',
      dismissible: true,
      onDismiss: onDismiss ?? (() => {}),
      onEscapeKeyDown: onEscape,
    });
  }

  /**
   * 注销浮层（并解除孤儿节点的父级指针引用）
   */
  public unregister(layerId: string): void {
    this.layers = this.layers.filter((l) => l.id !== layerId);

    // 解除将已销毁 Layer 作为 parentId 的孤儿节点指针，防止悬空引用
    for (const layer of this.layers) {
      if (layer.parentId === layerId) {
        layer.parentId = undefined;
      }
    }
  }

  /**
   * 获取当前处于活跃状态的最顶层 Layer
   */
  public getTopLayer(): LayerRegistration | undefined {
    if (this.layers.length === 0) return undefined;
    return this.layers[this.layers.length - 1];
  }

  /**
   * 获取所有已注册浮层（按入栈顺序）
   */
  public getLayers(): readonly LayerRegistration[] {
    return this.layers;
  }

  /**
   * 判断是否存在活跃的模态浮层（用于全局快捷键守卫）
   */
  public hasActiveModal(): boolean {
    return this.layers.some(
      (l) => l.modal || l.type === 'modal-dialog' || l.type === 'confirm-dialog'
    );
  }

  /**
   * 获取指定 Layer 的所有直接与间接子孙浮层
   */
  public getDescendants(layerId: string): LayerRegistration[] {
    const results: LayerRegistration[] = [];
    const directChildren = this.layers.filter((l) => l.parentId === layerId);

    for (const child of directChildren) {
      results.push(child);
      results.push(...this.getDescendants(child.id));
    }

    return results;
  }

  /**
   * 主动关闭顶层浮层
   */
  public dismissTop(reason: DismissReason): boolean {
    const top = this.getTopLayer();
    if (!top || !top.dismissible) return false;

    this.dismissLayer(top.id, reason);
    return true;
  }

  /**
   * 关闭指定浮层及其所有子孙浮层，记录 Trace 审计，并还原焦点
   */
  public dismissLayer(layerId: string, reason: DismissReason): void {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer) return;

    // 1. 级联关闭所有子孙浮层
    const descendants = this.getDescendants(layerId);
    for (let i = descendants.length - 1; i >= 0; i--) {
      const child = descendants[i];
      if (child && child.dismissible) {
        try {
          child.onDismiss('parent-dismissed');
        } catch (err) {
          console.error('[LayerStackService] Error in cascade dismiss:', err);
        }
        this.recordTrace(child, 'parent-dismissed');
        this.unregister(child.id);
      }
    }

    // 2. 关闭自身并记录 Trace 审计
    if (reason === 'escape') {
      this.lastEscapeDismissTime = Date.now();
    }
    try {
      layer.onDismiss(reason);
    } catch (err) {
      console.error('[LayerStackService] Error in layer onDismiss:', err);
    }
    this.recordTrace(layer, reason);
    this.unregister(layer.id);

    // 3. 焦点平滑还原（仅 Esc 与选中项操作还原焦点；外点交互尊重用户外部聚焦目标）
    if (reason === 'escape' || reason === 'item-select') {
      this.restoreFocus(layer);
    }
  }

  /**
   * 记录生命周期 Trace 审计
   */
  private recordTrace(layer: LayerRegistration, reason: DismissReason): void {
    this.traceHistory.push({
      id: layer.id,
      type: layer.type,
      parentId: layer.parentId,
      mountedAt: layer.mountedAt,
      dismissedAt: Date.now(),
      dismissReason: reason,
    });
    if (this.traceHistory.length > LayerStackService.MAX_TRACE_HISTORY) {
      this.traceHistory.shift();
    }
  }

  /**
   * 获取生命周期 Trace 审计历史
   */
  public getTraceHistory(): readonly LayerTraceRecord[] {
    return this.traceHistory;
  }

  /**
   * 清空 Trace 审计历史
   */
  public clearTraceHistory(): void {
    this.traceHistory = [];
  }

  /**
   * 焦点平滑还原算法
   */
  private restoreFocus(layer: LayerRegistration): void {
    if (typeof requestAnimationFrame === 'undefined') return;

    requestAnimationFrame(() => {
      // 1. 显式指定的 restoreFocusTarget
      if (
        layer.restoreFocusTarget &&
        typeof layer.restoreFocusTarget.focus === 'function'
      ) {
        layer.restoreFocusTarget.focus();
        return;
      }

      // 2. 绑定的 anchorRef 触发器
      const anchorEl = this.resolveElement(layer.anchorRef);
      if (anchorEl && typeof anchorEl.focus === 'function') {
        anchorEl.focus();
        return;
      }

      // 3. 若存在父级 Layer，回退到父级容器的首个可聚焦元素
      if (layer.parentId) {
        const parentLayer = this.layers.find((l) => l.id === layer.parentId);
        if (parentLayer) {
          const parentEl = this.resolveElement(parentLayer.elementRef);
          const firstFocusable = parentEl?.querySelector<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          firstFocusable?.focus();
        }
      }
    });
  }

  /**
   * 绑定全局单一监听器
   */
  private attachGlobalListeners(): void {
    if (
      this.isListening ||
      typeof window === 'undefined' ||
      typeof document === 'undefined'
    ) {
      return;
    }

    window.addEventListener('keydown', this.handleGlobalKeyDown, true);
    window.addEventListener('pointerdown', this.handleGlobalPointerDown, true);
    document.addEventListener('keydown', this.handleGlobalKeyDown, true);
    document.addEventListener(
      'pointerdown',
      this.handleGlobalPointerDown,
      true
    );
    this.isListening = true;
  }

  /**
   * 全局单一 Keydown 调度处理器（自顶向下寻找首个响应者，根除 dismissible:false 调度死锁）
   */
  private handleGlobalKeyDown = (event: KeyboardEvent): void => {
    if (PROCESSED_EVENTS.has(event)) return;
    PROCESSED_EVENTS.add(event);

    // 1. 守卫 IME 输入法合成态（isComposing / keyCode 229 / Process / nativeEvent.isComposing）
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === 'Process' ||
      (event as unknown as { nativeEvent?: { isComposing?: boolean } })
        .nativeEvent?.isComposing
    ) {
      return; // 绝不拦截、绝不消费，保护输入法中文候选框选词
    }

    if (event.key !== 'Escape') return;

    // 同帧/短时间防抖（50ms 内快速双击 Esc 时，逐帧退栈，绝不一击穿透全部关闭，满足 GEO-ESC-06）
    const now = Date.now();
    if (
      this.lastEscapeDismissTime &&
      now >= this.lastEscapeDismissTime &&
      now - this.lastEscapeDismissTime < 50
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.layers.length === 0) {
      // 栈中无浮层，放行至全局 ShortcutService
      return;
    }

    // 2. 自顶向下倒序寻找首个能够消费或退栈的活跃 Layer (Top-down First Responder Search)
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (!layer) continue;

      // A. 若当前层提供了自定义 onEscapeKeyDown 钩子（如快捷键录制态、子状态回退）
      if (typeof layer.onEscapeKeyDown === 'function') {
        try {
          const handled = layer.onEscapeKeyDown(event);
          if (handled === true || event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            return; // 消费成功，终止传递
          }
        } catch (err) {
          console.error('[LayerStackService] Error in onEscapeKeyDown:', err);
        }
      }

      // B. 若当前层允许 Esc 关闭
      if (layer.dismissible) {
        event.preventDefault();
        event.stopPropagation();
        this.dismissLayer(layer.id, 'escape');
        return; // 成功关闭顶层可退栈浮层，终止传递
      }

      // C. 若当前层是阻断型模态层（modal: true），但明确禁止 dismissible，
      // 按模态语义必须阻断 Esc 击穿到底层应用，直接消费并终止
      if (layer.modal) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // D. 若为普通的 non-dismissible 轻量层（如 Toast、静态 Tooltip），继续向下穿透探测下一层
    }
  };

  /**
   * 全局单一 PointerDown 调度处理器（Branch-Aware 外点判定）
   */
  private handleGlobalPointerDown = (event: PointerEvent): void => {
    if (PROCESSED_EVENTS.has(event)) return;
    PROCESSED_EVENTS.add(event);

    const target = event.target as Node | null;
    if (!target) return;

    const topLayer = this.getTopLayer();
    if (!topLayer || !topLayer.dismissible) return;

    // 1. 检查点击是否位于顶层容器内部
    const topEl = this.resolveElement(topLayer.elementRef);
    if (topEl && topEl.contains(target)) {
      return; // 内部点击，不触发外点关闭
    }

    // 2. 检查点击是否位于关联的 Anchor / Trigger 触发源内部
    const anchorEl = this.resolveElement(topLayer.anchorRef);
    if (anchorEl && anchorEl.contains(target)) {
      return; // 触发源自身事件管理开关，避免 Double Toggle 震荡
    }

    // 3. 检查点击是否位于任何子孙 Branch 浮层内部（如 Tooltip / 二级 Submenu）
    const descendants = this.getDescendants(topLayer.id);
    for (const child of descendants) {
      if (!child) continue;
      const childEl = this.resolveElement(child.elementRef);
      if (childEl && childEl.contains(target)) {
        return; // 点击在子分支内，视为内部交互，严禁误关父层！
      }
    }

    // 4. 确认属于外部点击，仅关闭顶层 Layer
    this.dismissLayer(topLayer.id, 'outside-pointer');
  };

  /**
   * 解析 Ref 或 DOM 元素
   */
  private resolveElement(
    ref?: React.RefObject<HTMLElement | null> | HTMLElement | null
  ): HTMLElement | null {
    if (!ref) return null;
    if ('current' in ref) return ref.current;
    return ref;
  }

  /**
   * 销毁并清理全局监听（供热更新与测试使用）
   */
  public dispose(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this.handleGlobalKeyDown, true);
      document.removeEventListener(
        'pointerdown',
        this.handleGlobalPointerDown,
        true
      );
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.handleGlobalKeyDown, true);
      window.removeEventListener(
        'pointerdown',
        this.handleGlobalPointerDown,
        true
      );
    }
    this.layers = [];
    this.traceHistory = [];
    this.lastEscapeDismissTime = 0;
    this.sequence = 0;
    this.isListening = false;
    LayerStackService.instance = null;
  }
}

export const layerStackService = LayerStackService.getInstance();
