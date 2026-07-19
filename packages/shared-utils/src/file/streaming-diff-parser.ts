/**
 * StreamingDiffParser
 *
 * 流式 unified diff 解析器，支持分块输入（feed chunk）。
 *
 * 设计意图：
 * - 处理跨块传输的行边界（buffer 存不完整行）
 * - 维护 oldLine / newLine 计数器用于行号追踪
 * - 输出 DiffChange[] 数组，按变更类型分组
 *
 * 性能特征：
 * - O(n) 时间，O(chunkSize) 内存
 * - feed() 每次返回当前 chunk 能解析出的所有变更
 * - flushRemaining() 刷新剩余缓冲
 */
export interface DiffChange {
  type: "addition" | "deletion" | "normal";
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface ParsedHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

type ParserState =
  | "header"    // 非 hunk 区域（diff --git / --- / +++ / 空行）
  | "hunk"      // hunk 内部（@@ 之后的 + / - / 空格行）
  | "skip";     // 不处理的状态

export class StreamingDiffParser {
  private buffer = "";
  private state: ParserState = "header";
  private oldLine = 0;
  private newLine = 0;
  private oldCount = 0;
  private newCount = 0;
  private changes: DiffChange[] = [];

  /**
   * 注入文本块，返回解析出的变更。
   * 内部维护跨块的行边界缓冲。
   */
  feed(chunk: string): DiffChange[] {
    this.buffer += chunk;
    return this.parseBuffer();
  }

  /** 刷新剩余缓冲，返回最后一批变更。 */
  flushRemaining(): DiffChange[] {
    if (this.buffer.length > 0 && this.state === "hunk") {
      // 尝试处理剩余行
      this.buffer += "\n";
      this.parseBuffer();
    }
    this.buffer = "";
    return this.changes.splice(0, this.changes.length);
  }

  /** 重置解析器状态。 */
  reset(): void {
    this.buffer = "";
    this.state = "header";
    this.oldLine = 0;
    this.newLine = 0;
    this.oldCount = 0;
    this.newCount = 0;
    this.changes = [];
  }

  private parseBuffer(): DiffChange[] {
    const idx = this.buffer.lastIndexOf("\n");
    if (idx === -1) return []; // 不完整行，等下一块

    const complete = this.buffer.slice(0, idx + 1);
    this.buffer = this.buffer.slice(idx + 1);

    const lines = complete.split("\n");
    // 最后一项是空字符串（因为有末尾换行）
    lines.pop();

    for (const line of lines) {
      this.processLine(line);
    }

    return this.changes.splice(0, this.changes.length);
  }

  private processLine(line: string): void {
    if (this.state === "header") {
      // 检测 hunk header
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        this.state = "hunk";
        this.oldLine = parseInt(hunkMatch[1]!, 10);
        this.oldCount = parseInt(hunkMatch[2] ?? "1", 10);
        this.newLine = parseInt(hunkMatch[3]!, 10);
        this.newCount = parseInt(hunkMatch[4] ?? "1", 10);
      }
      return;
    }

    if (this.state === "hunk") {
      if (line.startsWith("@@")) {
        // 新的 hunk
        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
          this.oldLine = parseInt(hunkMatch[1]!, 10);
          this.oldCount = parseInt(hunkMatch[2] ?? "1", 10);
          this.newLine = parseInt(hunkMatch[3]!, 10);
          this.newCount = parseInt(hunkMatch[4] ?? "1", 10);
        }
        return;
      }

      if (line.startsWith("+")) {
        const content = line.slice(1);
        this.changes.push({
          type: "addition",
          content,
          newLine: this.newLine,
        });
        this.newLine++;
        return;
      }

      if (line.startsWith("-")) {
        const content = line.slice(1);
        this.changes.push({
          type: "deletion",
          content,
          oldLine: this.oldLine,
        });
        this.oldLine++;
        return;
      }

      // 上下文行（以空格开头或空行）
      const content = line.startsWith(" ") ? line.slice(1) : line;
      this.changes.push({
        type: "normal",
        content,
        oldLine: this.oldLine,
        newLine: this.newLine,
      });
      this.oldLine++;
      this.newLine++;
      return;
    }
  }
}
