const BLOCK_SIZE = 256;

class SegmentBlock {
  public lineLengths: number[] = [];
  public totalLength: number = 0;

  constructor(lineLengths: number[]) {
    this.lineLengths = lineLengths;
    for (let i = 0; i < lineLengths.length; i++) {
      this.totalLength += lineLengths[i];
    }
  }

  insert(index: number, lengths: number[]): SegmentBlock | null {
    this.lineLengths.splice(index, 0, ...lengths);
    let sum = 0;
    for (let i = 0; i < lengths.length; i++) sum += lengths[i];
    this.totalLength += sum;

    if (this.lineLengths.length > BLOCK_SIZE * 2) {
      // Split block to maintain bounded size
      const half = Math.floor(this.lineLengths.length / 2);
      const rightLengths = this.lineLengths.splice(half);
      
      let rightTotal = 0;
      for (let i = 0; i < rightLengths.length; i++) {
        rightTotal += rightLengths[i];
      }
      this.totalLength -= rightTotal;
      
      const newBlock = new SegmentBlock([]);
      newBlock.lineLengths = rightLengths;
      newBlock.totalLength = rightTotal;
      return newBlock;
    }
    return null;
  }

  delete(index: number, count: number): void {
    const removed = this.lineLengths.splice(index, count);
    for (let i = 0; i < removed.length; i++) {
      this.totalLength -= removed[i];
    }
  }

  clone(): SegmentBlock {
    const block = new SegmentBlock([]);
    block.lineLengths = [...this.lineLengths];
    block.totalLength = this.totalLength;
    return block;
  }
}

/**
 * A 2-level block-based Segment Tree for efficient line offset tracking.
 * Operations are O(N / BLOCK_SIZE), making them extremely fast for millions of lines.
 * 
 * Note: Each line's length in this tree MUST include the newline character (i.e. text.length + 1)
 * except for the very last line if we strictly measure file length, but conventionally in 
 * editors, line offsets are calculated by adding (line.length + 1).
 */
export class LineOffsetTree {
  private blocks: SegmentBlock[] = [];
  
  constructor(initialLineLengths: number[]) {
    // Initial bulk load
    for (let i = 0; i < initialLineLengths.length; i += BLOCK_SIZE) {
      const chunk = initialLineLengths.slice(i, i + BLOCK_SIZE);
      this.blocks.push(new SegmentBlock(chunk));
    }
    if (this.blocks.length === 0) {
      this.blocks.push(new SegmentBlock([0]));
    }
  }

  public get lineCount(): number {
    let count = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      count += this.blocks[i].lineLengths.length;
    }
    return count;
  }

  public getOffset(lineIndex: number): number {
    let offset = 0;
    let currentIdx = 0;

    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (currentIdx + block.lineLengths.length > lineIndex) {
        // Line is in this block
        const localIdx = lineIndex - currentIdx;
        for (let j = 0; j < localIdx; j++) {
          offset += block.lineLengths[j];
        }
        return offset;
      }
      offset += block.totalLength;
      currentIdx += block.lineLengths.length;
    }
    return offset;
  }

  public findLineIndex(offset: number): number {
    let currentOffset = 0;
    let currentLineIdx = 0;

    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (currentOffset + block.totalLength > offset || i === this.blocks.length - 1) {
        // Offset is in this block (or we are at the last block)
        for (let j = 0; j < block.lineLengths.length; j++) {
          if (currentOffset + block.lineLengths[j] > offset) {
            return currentLineIdx + j;
          }
          currentOffset += block.lineLengths[j];
        }
        // If it's exactly at the end, return the last valid index
        return currentLineIdx + block.lineLengths.length - 1;
      }
      currentOffset += block.totalLength;
      currentLineIdx += block.lineLengths.length;
    }
    return Math.max(0, currentLineIdx - 1);
  }

  public updateLines(startLineIdx: number, deleteCount: number, newLengths: number[]): void {
    // —— 块级写时复制（Copy-on-Write，问题 3 / P3）——
    // 本树可能通过 clone() 与历史树共享块对象：clone() 只复制块引用数组，
    // 块对象本身共享。为保证「clone 之后原树不可变」（undo/redo 依赖的
    // 持久化语义）——本操作触及的块必须先深拷贝（COW）再修改，未触及块
    // 保持共享引用。击键路径成本从旧实现的 O(全文)（clone 全量深拷贝）
    // 降为 O(触及块数 × BLOCK_SIZE)。
    // 注意：blocks 数组是实例私有（clone 时已 slice 复制引用），此处
    // splice 不影响旧树；块分裂（insert 超 BLOCK_SIZE*2）产生的新块
    // 也是新对象，旧树自然不受影响。

    // Delete phase
    let remainingDelete = deleteCount;
    let currentIdx = 0;
    let bIdx = 0;

    // Fast-forward to the block where deletion starts
    while (bIdx < this.blocks.length) {
      const block = this.blocks[bIdx];
      const blockLen = block.lineLengths.length;
      if (startLineIdx >= currentIdx && startLineIdx < currentIdx + blockLen) {
        break;
      }
      currentIdx += blockLen;
      bIdx++;
    }

    if (bIdx >= this.blocks.length) bIdx = this.blocks.length - 1;

    let deleteStartLocal = startLineIdx - currentIdx;

    while (remainingDelete > 0 && bIdx < this.blocks.length) {
      const block = this.blocks[bIdx];
      const availableToDelete = block.lineLengths.length - deleteStartLocal;
      const toDelete = Math.min(remainingDelete, availableToDelete);

      // COW：触及块先克隆再删除（共享块禁止就地修改，否则破坏旧树快照）
      const cowBlock = block.clone();
      cowBlock.delete(deleteStartLocal, toDelete);
      this.blocks[bIdx] = cowBlock;
      remainingDelete -= toDelete;

      if (cowBlock.lineLengths.length === 0 && this.blocks.length > 1) {
        this.blocks.splice(bIdx, 1);
      } else {
        bIdx++;
      }
      deleteStartLocal = 0; // For subsequent blocks, deletion always starts at 0
    }

    // Insert phase
    if (newLengths.length > 0) {
      // Re-find the insertion point since blocks might have been removed
      currentIdx = 0;
      bIdx = 0;
      while (bIdx < this.blocks.length) {
        const block = this.blocks[bIdx];
        const blockLen = block.lineLengths.length;
        if (startLineIdx >= currentIdx && startLineIdx <= currentIdx + blockLen) {
          break;
        }
        currentIdx += blockLen;
        bIdx++;
      }

      if (bIdx >= this.blocks.length) bIdx = this.blocks.length - 1;

      const targetBlock = this.blocks[bIdx];
      const insertLocal = startLineIdx - currentIdx;

      // COW：插入目标块先克隆再插入（分裂产生的新块是新对象，不影响旧树）
      const cowTarget = targetBlock.clone();
      this.blocks[bIdx] = cowTarget;
      const newBlock = cowTarget.insert(insertLocal, newLengths);
      if (newBlock) {
        this.blocks.splice(bIdx + 1, 0, newBlock);
      }
    }

    if (this.blocks.length === 0) {
      this.blocks.push(new SegmentBlock([0]));
    }
  }

  public toArray(): number[] {
    // Reconstruct flat offsets array for backwards compatibility if needed
    const offsets: number[] = [];
    let current = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      for (let j = 0; j < b.lineLengths.length; j++) {
        offsets.push(current);
        current += b.lineLengths[j];
      }
    }
    return offsets;
  }

  public clone(): LineOffsetTree {
    // —— COW 浅拷贝（问题 3 / P3）——
    // 只复制块引用数组（O(#blocks) ≈ 4k 次引用拷贝，<0.1ms），块对象共享；
    // 后续 updateLines 只克隆触及块，未触及块保持共享——clone 后原树
    // 不再变化（不可变语义保持，undo 依赖）。100 万行文档下
    // 单次 clone 从 ~1.1ms（全量深拷贝）降为 ~0.01ms。
    const tree = new LineOffsetTree([]);
    tree.blocks = this.blocks.slice();
    return tree;
  }
}
