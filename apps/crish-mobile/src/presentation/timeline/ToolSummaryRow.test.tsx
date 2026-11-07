// 工具摘要行样式口径（任务四 B)：与思考状态行同字号（callout 14)、
// 无描边、fillSubtle 底；失败计数保持 danger 状态色且同字号。
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { ToolSummaryRow } from './ToolSummaryRow';
import type { ToolRunBlock } from './groupToolRuns';
import type { ToolBlock } from './buildTimeline';

function makeRun(failed: number): ToolRunBlock {
  const tool: ToolBlock = {
    kind: 'tool',
    id: 't-1',
    toolName: 'read_file',
    intent: '读取配置文件',
    summary: '',
    status: 'done',
    output: '',
    atMs: 1000,
  };
  return {
    kind: 'toolRun',
    id: 'run-1',
    tools: [tool],
    running: 0,
    failed,
    status: failed > 0 ? 'error' : 'success',
    active: false,
    isSealed: true,
    latest: tool,
    atMs: 1000,
  };
}

describe('ToolSummaryRow · 任务四 B 行样式', () => {
  it('胶囊无描边、fillSubtle 底，标签字号 callout（14）', async () => {
    const view = await render(<ToolSummaryRow run={makeRun(0)} />);

    const capsule = view.getByTestId('tool-run-run-1');
    const capsuleStyle = StyleSheet.flatten(capsule.props.style);
    expect(capsuleStyle.borderWidth).toBeUndefined();
    // fillSubtle（浅色 #f4f4f4），与思考状态行同底；不再是 surfaceGrouped
    expect(capsuleStyle.backgroundColor).toBe('#f4f4f4');

    const label = view.getByText('读取配置文件');
    const labelStyle = StyleSheet.flatten(label.props.style);
    expect(labelStyle.fontSize).toBe(14);
    await view.unmount();
  });

  it('失败计数同字号（callout）且保持 danger 色', async () => {
    const view = await render(<ToolSummaryRow run={makeRun(2)} />);

    const failed = view.getByText(/个失败/);
    const failedStyle = StyleSheet.flatten(failed.props.style);
    expect(failedStyle.fontSize).toBe(14);
    expect(failedStyle.color).toBeDefined();
    expect(failedStyle.color).not.toBe('#171717');
    await view.unmount();
  });
});
