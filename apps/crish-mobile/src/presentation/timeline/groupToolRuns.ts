// 把相邻的工具块折叠成一行摘要（纯函数，jest 直测）。
// 消息 / 审批 / 提示块原样透传并打断折叠；单个工具同样折叠成摘要，便于对话保持干净。
import type { TimelineBlock, ToolBlock } from './buildTimeline';

export interface ToolRunBlock {
  kind: 'toolRun';
  /** 首个工具块 id：作为 /tools/[sessionId]?focus= 的定位锚点 */
  id: string;
  tools: ToolBlock[];
  running: number;
  failed: number;
  latest: ToolBlock;
  atMs: number;
}

export type DisplayBlock = Exclude<TimelineBlock, ToolBlock> | ToolRunBlock;

export function groupToolRuns(
  blocks: readonly TimelineBlock[]
): DisplayBlock[] {
  const out: DisplayBlock[] = [];
  let run: ToolRunBlock | null = null;
  for (const block of blocks) {
    if (block.kind !== 'tool') {
      run = null;
      out.push(block);
      continue;
    }
    if (!run) {
      run = {
        kind: 'toolRun',
        id: block.id,
        tools: [],
        running: 0,
        failed: 0,
        latest: block,
        atMs: block.atMs,
      };
      out.push(run);
    }
    run.tools.push(block);
    run.latest = block;
    if (block.status === 'running') run.running += 1;
    if (block.status === 'error') run.failed += 1;
  }
  return out;
}
