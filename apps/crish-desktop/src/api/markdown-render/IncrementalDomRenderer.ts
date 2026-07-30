/**
 * DOM 块级 patch 渲染器：finalized 块 appendChild 一次，tail 块单节点 innerHTML。
 *
 * 设计：
 * - 零 diff：不比较新旧 HTML，直接 appendChild 新块 + innerHTML 更新 tail
 * - 零 morphdom：不依赖任何 DOM diff 库
 * - finalized 块不动：已创建的 data-block-id 节点创建后永不修改
 * - tail 单节点：始终最多一个 data-block-tail 节点，每帧 innerHTML 覆盖
 * - 性能：render 复杂度 O(新增块数 + 1)，与总块数无关；每帧 DOM 操作 < 0.1ms
 *
 * 容器结构：
 *   <div class="md-rendered">
 *     <div data-block-id="0">...</div>   <!-- finalized，创建后不动 -->
 *     <div data-block-id="1">...</div>
 *     <div data-block-tail="true">...</div> <!-- tail，每帧 innerHTML -->
 *   </div>
 */

import type { IncrementalParseResult } from './IncrementalMarkdownParser';

export class IncrementalDomRenderer {
  private container: HTMLElement;
  /** 已创建的 finalized 节点数（data-block-id 0..N-1） */
  private renderedBlockCount = 0;
  /** 当前 tail 节点（最多一个；null 表示无 tail） */
  private tailNode: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * 应用增量解析结果到 DOM。
   * - finalizedBlocks 中新增的块 → appendChild 创建（data-block-id 标记）
   * - tailBlock → 单节点 innerHTML 更新（data-block-tail 标记）
   * - 已存在的 finalized 块 → 不动
   */
  render(result: IncrementalParseResult): void {
    // 防御：finalizedBlocks 只增不减；若 blockCount 回退，视为状态错乱，reset 重建
    if (result.blockCount < this.renderedBlockCount) {
      this.reset();
    }

    // 1. 新增 finalized 块 → appendChild
    //    旧 tail 必须先移除（若存在），保证 finalized 节点连续排列在 tail 之前；
    //    随后步骤 2 会按需重新创建 tail 节点
    if (result.blockCount > this.renderedBlockCount && this.tailNode) {
      this.container.removeChild(this.tailNode);
      this.tailNode = null;
    }
    while (this.renderedBlockCount < result.blockCount) {
      const block = result.finalizedBlocks[this.renderedBlockCount]!;
      const node = document.createElement('div');
      node.setAttribute('data-block-id', String(this.renderedBlockCount));
      node.innerHTML = block.html;
      this.container.appendChild(node);
      this.renderedBlockCount++;
    }

    // 2. tail 块更新：有非空 html → 单节点 innerHTML；否则移除 tail 节点
    if (result.tailBlock && result.tailBlock.html) {
      if (!this.tailNode) {
        this.tailNode = document.createElement('div');
        this.tailNode.setAttribute('data-block-tail', 'true');
        this.container.appendChild(this.tailNode);
      }
      this.tailNode.innerHTML = result.tailBlock.html;
    } else if (this.tailNode) {
      this.container.removeChild(this.tailNode);
      this.tailNode = null;
    }
  }

  /**
   * 流式→完成态切换：用 Rust HTML 替换全部。
   * 一次性 container.innerHTML = rustHtml，清理所有内部状态。
   */
  finalize(rustHtml: string): void {
    this.container.innerHTML = rustHtml;
    this.renderedBlockCount = 0;
    this.tailNode = null;
  }

  /** 重置（新消息） */
  reset(): void {
    this.container.innerHTML = '';
    this.renderedBlockCount = 0;
    this.tailNode = null;
  }

  /** 释放资源 */
  dispose(): void {
    this.container = null!;
    this.tailNode = null;
  }
}
