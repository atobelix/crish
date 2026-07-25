/**
 * 快捷键服务。
 *
 * 单例模式，统一管理所有快捷键的注册、事件派发、序列键引擎、
 * 冲突检测与自定义覆盖。依赖 ShortcutPlatformAdapt 与 ShortcutRegistry。
 */

import { IS_MAC, formatForDisplay as platformFormat } from './ShortcutPlatformAdapt';
import { BUILTIN_SHORTCUTS, type ShortcutMeta } from './ShortcutRegistry';
import { configService } from './ConfigService';

/** Shift 键产生字符到原始键的映射 */
const SHIFT_MAP: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};

export class ShortcutService {
  private static instance: ShortcutService;
  private static readonly SEQUENCE_TIMEOUT = 500;

  private actions = new Map<string, { binding: string; meta: ShortcutMeta }>();
  private customOverrides = new Map<string, string>();
  private sequenceBuffer: { key: string; time: number }[] = [];
  private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundKeyUp: ((e: KeyboardEvent) => void) | null = null;
  private container: HTMLElement | Document | null = null;
  private matchCallbacks: Array<(match: { actionId: string; meta: ShortcutMeta; originalEvent: KeyboardEvent }) => void> = [];
  private contextRoots = new Map<string, HTMLElement>();

  static getInstance(): ShortcutService {
    if (!ShortcutService.instance) {
      ShortcutService.instance = new ShortcutService();
    }
    return ShortcutService.instance;
  }

  private constructor() {
    for (const shortcut of BUILTIN_SHORTCUTS) {
      this.register(shortcut.id, shortcut.defaultBinding, shortcut);
    }
    this.loadCustomOverrides();
  }

  // ─── 生命周期 ────────────────────────────────────

  /** 初始化：在 container（默认 document）上注册 keydown/keyup 监听 */
  init(container?: HTMLElement | Document): void {
    if (this.boundKeyDown) return;
    this.container = container ?? document;
    this.boundKeyDown = (e: KeyboardEvent) => {
      const result = this.handleKeyDown(e);
      if (result) {
        for (const cb of this.matchCallbacks) {
          try { cb({ ...result, originalEvent: e }); } catch { /* callback error */ }
        }
      }
    };
    this.boundKeyUp = () => {
      // reserved for future use
    };
    this.container.addEventListener('keydown', this.boundKeyDown as EventListener);
    this.container.addEventListener('keyup', this.boundKeyUp as EventListener);
    this.loadCustomOverrides();
  }

  /** 销毁：移除所有 DOM 监听，清空序列缓冲和回调 */
  destroy(): void {
    if (this.container && this.boundKeyDown) {
      this.container.removeEventListener('keydown', this.boundKeyDown as EventListener);
    }
    if (this.container && this.boundKeyUp) {
      this.container.removeEventListener('keyup', this.boundKeyUp as EventListener);
    }
    this.boundKeyDown = null;
    this.boundKeyUp = null;
    this.container = null;
    this.sequenceBuffer = [];
    this.matchCallbacks = [];
  }

  /** 注册快捷键匹配回调，返回取消订阅函数 */
  onMatch(cb: (match: { actionId: string; meta: ShortcutMeta; originalEvent: KeyboardEvent }) => void): () => void {
    this.matchCallbacks.push(cb);
    return () => {
      const idx = this.matchCallbacks.indexOf(cb);
      if (idx >= 0) this.matchCallbacks.splice(idx, 1);
    };
  }

  // ─── 上下文作用域 ─────────────────────────────────

  /** 注册一个上下文根元素，用于 context scoping */
  registerContextRoot(context: string, element: HTMLElement): void {
    this.contextRoots.set(context, element);
  }

  /** 注销上下文根元素 */
  unregisterContextRoot(context: string): void {
    this.contextRoots.delete(context);
  }

  private isInContext(context: string): boolean {
    if (context === 'global') return true;
    const root = this.contextRoots.get(context);
    if (!root) return false;
    return root.contains(document.activeElement);
  }

  /** 注册快捷键 */
  register(actionId: string, binding: string, meta?: ShortcutMeta): void {
    const resolved = this.resolvePlatformBinding(binding, meta);
    this.actions.set(actionId, {
      binding: resolved,
      meta: meta ?? {
        id: actionId,
        defaultBinding: binding,
        category: 'system',
        label: actionId,
        keywords: [],
      },
    });
  }

  /** 注销快捷键 */
  unregister(actionId: string): void {
    this.actions.delete(actionId);
  }

  /** 处理键盘事件，返回匹配的快捷键或 null */
  handleKeyDown(e: KeyboardEvent): { actionId: string; meta: ShortcutMeta } | null {
    if (e.repeat) return null;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;

    // 先清空超时的缓冲区条目
    this.clearSequenceBuffer();

    // 将当前按键加入序列缓冲区
    this.sequenceBuffer.push({ key: e.key, time: Date.now() });

    // 1. 检查是否匹配序列键绑定（如 "Escape Escape"）
    const seqMatch = this.matchSequenceBinding();
    if (seqMatch) return seqMatch;

    // 2. 检查缓冲区是否为某个序列绑定的前缀（需要等待更多按键）
    if (this.isSequencePrefix()) return null;

    // 3. 缓冲区无法匹配任何序列，清空缓冲区并尝试单次按键匹配
    this.sequenceBuffer = [];
    return this.matchSingleKeyBinding(e);
  }

  // ─── 序列键引擎 ─────────────────────────────────

  /** 清空超时（>500ms）的缓冲区条目 */
  private clearSequenceBuffer(): void {
    const now = Date.now();
    this.sequenceBuffer = this.sequenceBuffer.filter(
      b => now - b.time < ShortcutService.SEQUENCE_TIMEOUT
    );
  }

  /** 尝试匹配序列键绑定 */
  private matchSequenceBinding(): { actionId: string; meta: ShortcutMeta } | null {
    const bufferStr = this.sequenceBuffer.map(b => b.key).join(' ');
    for (const [actionId, { binding, meta }] of this.actions) {
      if (binding === bufferStr) {
        this.sequenceBuffer = [];
        return { actionId, meta };
      }
    }
    return null;
  }

  /** 检查当前缓冲区是否为某个序列绑定的前缀 */
  private isSequencePrefix(): boolean {
    const bufferStr = this.sequenceBuffer.map(b => b.key).join(' ');
    for (const { binding } of this.actions.values()) {
      const parts = binding.split(/\s+/);
      if (parts.length <= 1) continue;
      const prefix = parts.slice(0, this.sequenceBuffer.length).join(' ');
      if (prefix === bufferStr && parts.length > this.sequenceBuffer.length) {
        return true;
      }
    }
    return false;
  }

  // ─── 单次按键匹配 ───────────────────────────────

  private matchSingleKeyBinding(e: KeyboardEvent): { actionId: string; meta: ShortcutMeta } | null {
    const matches: Array<{ actionId: string; meta: ShortcutMeta }> = [];
    for (const [actionId, { binding, meta }] of this.actions) {
      if (binding.includes(' ')) continue;
      if (!this.isInContext(meta.context ?? 'global')) continue;
      if (this.matchSingleKey(e, binding)) {
        matches.push({ actionId, meta });
      }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => (b.meta.priority ?? 0) - (a.meta.priority ?? 0));
    return { actionId: matches![0]!.actionId, meta: matches![0]!.meta };
  }

  private matchSingleKey(e: KeyboardEvent, binding: string): boolean {
    const parts = binding.split(' + ').map(p => p.trim());
    const keyPart = parts[parts.length - 1]!;
    const mods = new Set(parts.slice(0, -1));

    // 修饰键匹配（Mac 上 "Ctrl" 对应 metaKey/⌘，Windows 上对应 ctrlKey）
    if (IS_MAC) {
      if (e.metaKey !== mods.has('Ctrl')) return false;
      if (e.ctrlKey !== mods.has('Meta')) return false;
    } else {
      if (e.ctrlKey !== mods.has('Ctrl')) return false;
      if (e.metaKey !== mods.has('Meta')) return false;
    }
    if (e.shiftKey !== mods.has('Shift')) return false;
    if (e.altKey !== mods.has('Alt')) return false;

    return this.keysMatch(e.key, keyPart, e.shiftKey);
  }

  private keysMatch(actual: string, expected: string, shiftHeld: boolean): boolean {
    if (actual === expected) return true;
    if (actual === ' ' && expected === 'Space') return true;
    // Shift 产生字符 → 无 Shift 字符
    if (shiftHeld && actual.length === 1 && expected.length === 1) {
      if (SHIFT_MAP[actual] === expected) return true;
    }
    // 字母不区分大小写
    if (actual.length === 1 && expected.length === 1) {
      return actual.toUpperCase() === expected.toUpperCase();
    }
    return false;
  }

  // ─── 查询 ────────────────────────────────────────

  /** 获取快捷键的有效绑定字符串 */
  getBinding(actionId: string): string {
    return this.actions.get(actionId)?.binding ?? '';
  }

  /** 获取所有注册的快捷键元数据 */
  getAllActions(): ShortcutMeta[] {
    return Array.from(this.actions.values()).map(a => a.meta);
  }

  /** 按分类获取快捷键 */
  getByCategory(category: string): ShortcutMeta[] {
    return this.getAllActions().filter(m => m.category === category);
  }

  // ─── 冲突检测 ────────────────────────────────────

  /** 检测所有已注册快捷键中存在相同绑定的冲突 */
  detectConflicts(): { actionId: string; binding: string; conflictsWith: string }[] {
    const result: { actionId: string; binding: string; conflictsWith: string }[] = [];
    const bindingMap = new Map<string, string>();

    for (const [actionId, { binding }] of this.actions) {
      const existing = bindingMap.get(binding);
      if (existing) {
        result.push({ actionId, binding, conflictsWith: existing });
      } else {
        bindingMap.set(binding, actionId);
      }
    }

    return result;
  }

  // ─── 自定义覆盖 ──────────────────────────────────

  /** 从 configService 加载已保存的自定义覆盖 */
  loadCustomOverrides(): void {
    try {
      const overrides = configService.get<Record<string, string>>('shortcuts.overrides');
      for (const [id, binding] of Object.entries(overrides)) {
        this.customOverrides.set(id, binding);
        if (this.actions.has(id)) {
          const meta = this.actions.get(id)!.meta;
          this.actions.set(id, { binding, meta });
        }
      }
    } catch {
      // 解析失败忽略
    }
  }

  /** 设置单个快捷键的自定义绑定并持久化 */
  setCustomOverride(actionId: string, binding: string): void {
    this.customOverrides.set(actionId, binding);
    if (this.actions.has(actionId)) {
      const meta = this.actions.get(actionId)!.meta;
      this.actions.set(actionId, { binding, meta });
    }
    this.persistOverrides();
  }

  /** 重置单个快捷键的自定义绑定为默认值 */
  resetCustomOverride(actionId: string): void {
    this.customOverrides.delete(actionId);
    if (this.actions.has(actionId)) {
      const meta = this.actions.get(actionId)!.meta;
      this.actions.set(actionId, {
        binding: this.resolvePlatformBinding(meta.defaultBinding, meta),
        meta,
      });
    }
    this.persistOverrides();
  }

  private persistOverrides(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [id, binding] of this.customOverrides) {
        obj[id] = binding;
      }
      configService.set('shortcuts.overrides', obj);
    } catch {
      // 存储失败忽略
    }
  }

  // ─── 平台格式化 ──────────────────────────────────

  /** 将绑定字符串转为当前平台显示格式 */
  formatForDisplay(binding: string): string {
    return platformFormat(binding);
  }

  // ─── 内部 ────────────────────────────────────────

  /** 根据当前平台解析出实际使用的绑定字符串 */
  private resolvePlatformBinding(binding: string, meta?: ShortcutMeta): string {
    if (!meta?.platforms) return binding;
    const override = IS_MAC ? meta.platforms.mac : meta.platforms.win;
    return override ?? binding;
  }
}
