/**
 * DirectDomWriter — 全系统确定性物理原语 1：高频纯文本直写与双缓冲 rAF 样式合并
 *
 * 物理不变量：
 * 1. appendTextNode: O(chunk.length) 原生 Text.prototype.appendData 直写，100% 绕过 React Fiber/VDOM 协调；
 * 2. writeStylesFast: 极速原子写入行内样式与 CSS 变量，消除跨层 Props 传递与对象分配；
 * 3. scheduleStyleWrite / scheduleBatchedMutation: 双缓冲 rAF 合并调度，单帧内同节点多次样式更新自动合并为单次物理 Commit。
 */

export type DomStyleRecord = Record<string, string | number | null | undefined>;

function normalizeCssPropertyName(prop: string): string {
  if (prop.startsWith('--')) return prop;
  return prop.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

export class DirectDomWriter {
  /** 双缓冲突变队列：activeWriteQueue 接收当前帧写入，flush 时与 readQueue 交换实现零重入死锁 */
  private static activeMutations = new Set<() => void>();
  private static flushingMutations = new Set<() => void>();

  /** 双缓冲样式合并表：同一元素在单帧内的多次样式更新自动浅合并后一次性写入 DOM */
  private static activeStyleBuffer = new Map<
    HTMLElement,
    Record<string, string | null>
  >();
  private static flushingStyleBuffer = new Map<
    HTMLElement,
    Record<string, string | null>
  >();

  private static rafId: number | null = null;

  /**
   * 追加流式纯文本数据（直通原生 Text 节点，O(chunk.length) 零 VDOM 开销）
   */
  public static appendTextNode(
    node: Text | null | undefined,
    chunk: string
  ): void {
    if (!node || !chunk) return;
    node.appendData(chunk);
  }

  /**
   * 向容器的首个文本子节点追加或初始化文本（若无 Text 子节点则自动创建）
   */
  public static appendTextToElement(
    el: HTMLElement | null | undefined,
    chunk: string
  ): Text | null {
    if (!el || !chunk) return null;
    const lastChild = el.lastChild;
    if (lastChild && lastChild.nodeType === 3) {
      const textNode = lastChild as Text;
      textNode.appendData(chunk);
      return textNode;
    }
    const textNode = el.ownerDocument.createTextNode(chunk);
    el.appendChild(textNode);
    return textNode;
  }

  /**
   * 极速同步写入行内样式，阻断 React 级联重排
   */
  public static writeStylesFast(
    el: HTMLElement | null | undefined,
    styles: DomStyleRecord
  ): void {
    if (!el || !styles) return;
    const style = el.style;
    for (const [rawKey, val] of Object.entries(styles)) {
      const cssKey = normalizeCssPropertyName(rawKey);
      if (val === null || val === undefined || val === '') {
        style.removeProperty(cssKey);
      } else {
        style.setProperty(cssKey, String(val));
      }
    }
  }

  /**
   * 极速同步写入单个 CSS 自定义属性（CSS Variable）
   */
  public static writeCssVariable(
    el: HTMLElement | null | undefined,
    name: string,
    value: string | number | null | undefined
  ): void {
    if (!el || !name) return;
    const varName = name.startsWith('--') ? name : `--${name}`;
    if (value === null || value === undefined || value === '') {
      el.style.removeProperty(varName);
    } else {
      el.style.setProperty(varName, String(value));
    }
  }

  /**
   * 双缓冲 rAF 样式合并写入：
   * 单帧内针对同一 HTMLElement 的多次调用会自动合并属性字典，在下一帧 rAF 一次性写入。
   */
  public static scheduleStyleWrite(
    el: HTMLElement | null | undefined,
    styles: DomStyleRecord
  ): void {
    if (!el || !styles) return;
    let bucket = DirectDomWriter.activeStyleBuffer.get(el);
    if (!bucket) {
      bucket = Object.create(null) as Record<string, string | null>;
      DirectDomWriter.activeStyleBuffer.set(el, bucket);
    }
    for (const [rawKey, val] of Object.entries(styles)) {
      const cssKey = normalizeCssPropertyName(rawKey);
      bucket[cssKey] =
        val === null || val === undefined || val === '' ? null : String(val);
    }
    DirectDomWriter.ensureFlushScheduled();
  }

  /**
   * 调度单帧原子合并变异（双缓冲 Batch Commit in rAF）
   */
  public static scheduleBatchedMutation(mutation: () => void): void {
    if (typeof mutation !== 'function') return;
    DirectDomWriter.activeMutations.add(mutation);
    DirectDomWriter.ensureFlushScheduled();
  }

  /**
   * 立即同步排空所有待处理的双缓冲样式与 DOM 变异（供卸载清理或确定性测试使用）
   */
  public static flushSynchronously(): void {
    if (DirectDomWriter.rafId !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(DirectDomWriter.rafId);
      } else {
        clearTimeout(DirectDomWriter.rafId);
      }
      DirectDomWriter.rafId = null;
    }
    DirectDomWriter.flushAll();
  }

  /**
   * 获取当前待排空的任务与元素总数
   */
  public static getPendingCount(): number {
    return (
      DirectDomWriter.activeStyleBuffer.size +
      DirectDomWriter.activeMutations.size
    );
  }

  private static ensureFlushScheduled(): void {
    if (DirectDomWriter.rafId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      DirectDomWriter.rafId = requestAnimationFrame(DirectDomWriter.flushAll);
    } else {
      DirectDomWriter.rafId = setTimeout(
        DirectDomWriter.flushAll,
        0
      ) as unknown as number;
    }
  }

  private static flushAll = (): void => {
    DirectDomWriter.rafId = null;

    // 1. 交换双缓冲样式表并原子写入
    if (DirectDomWriter.activeStyleBuffer.size > 0) {
      const stylesToFlush = DirectDomWriter.activeStyleBuffer;
      DirectDomWriter.activeStyleBuffer = DirectDomWriter.flushingStyleBuffer;
      DirectDomWriter.activeStyleBuffer.clear();
      DirectDomWriter.flushingStyleBuffer = stylesToFlush;

      stylesToFlush.forEach((styleMap, el) => {
        const style = el.style;
        for (const [cssKey, val] of Object.entries(styleMap)) {
          if (val === null) {
            style.removeProperty(cssKey);
          } else {
            style.setProperty(cssKey, val);
          }
        }
      });
      stylesToFlush.clear();
    }

    // 2. 交换双缓冲变异回调队列并依次执行
    if (DirectDomWriter.activeMutations.size > 0) {
      const mutationsToRun = DirectDomWriter.activeMutations;
      DirectDomWriter.activeMutations = DirectDomWriter.flushingMutations;
      DirectDomWriter.activeMutations.clear();
      DirectDomWriter.flushingMutations = mutationsToRun;

      for (const mutation of mutationsToRun) {
        try {
          mutation();
        } catch (err) {
          console.error('[DirectDomWriter] Batched mutation error:', err);
        }
      }
      mutationsToRun.clear();
    }
  };
}
