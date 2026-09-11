/**
 * toolCommandType / toolCommandIcon 测试（决策 12 · 命令类型图标最小映射，V1-γ）。
 * 覆盖：13 类域 kind 判定 + misc 兜底 + kind→图标表完整性与兜底。
 */
import { describe, expect, it } from 'vitest';
import type { MessageToolCall } from '../../store/layoutStore';
import { toolCommandType, type ToolCommandKind } from './toolCommandType';
import { TOOL_COMMAND_ICONS, toolCommandIcon } from './toolCommandIcon';

function tc(name: string): MessageToolCall {
  return { id: 't1', name, status: 'success' };
}

describe('toolCommandType（与 toolDomainDescriptions 13 类域同序同谓词）', () => {
  const cases: Array<[string, ToolCommandKind]> = [
    // 1. shell
    ['run_command', 'shell'],
    ['bash', 'shell'],
    ['powershell', 'shell'],
    ['pwsh', 'shell'],
    // 2. network（先于 read，DEC-05）
    ['read_url_content', 'network'],
    ['read_browser_page', 'network'],
    ['web_search', 'network'],
    // 3. mcp
    ['read_resource', 'mcp'],
    ['list_resources', 'mcp'],
    ['call_mcp_tool', 'mcp'],
    ['mcp_query_page', 'mcp'],
    // 4. task
    ['manage_task', 'task'],
    ['background_task', 'task'],
    // 5. read
    ['read_file', 'read'],
    ['view_file', 'read'],
    ['cat', 'read'],
    // 6. write
    ['write_file', 'write'],
    ['write_to_file', 'write'],
    ['create_file', 'write'],
    // 7. edit
    ['replace_file_content', 'edit'],
    ['multi_replace_file_content', 'edit'],
    ['edit_file', 'edit'],
    // 8. workspace
    ['resolve_output_dir', 'workspace'],
    ['project_tree', 'workspace'],
    ['decompress_context', 'workspace'],
    // 9. delete
    ['delete_file', 'delete'],
    ['delete_dir', 'delete'],
    ['trash', 'delete'],
    // 10. list
    ['list_dir', 'list'],
    ['list_directory', 'list'],
    ['ls', 'list'],
    ['glob', 'list'],
    // 11. search
    ['grep_search', 'search'],
    ['search_code', 'search'],
    // 12. subagent
    ['run_subagent', 'subagent'],
    ['invoke_subagent', 'subagent'],
    ['wait_subagents', 'subagent'],
    ['send_message', 'subagent'],
    // 13. timer
    ['set_timer', 'timer'],
    ['schedule', 'timer'],
    ['cancel_timer', 'timer'],
    // 14. note
    ['note_query_blocks', 'note'],
    ['note_update_block', 'note'],
    // 兜底
    ['unknown_tool_xyz', 'misc'],
  ];

  for (const [name, kind] of cases) {
    it(`${name} → ${kind}`, () => {
      expect(toolCommandType(tc(name))).toBe(kind);
    });
  }

  it('名称大小写/连字符归一（与 toolLabelFromArgs 同归一）', () => {
    expect(toolCommandType(tc('Read_File'))).toBe('read');
    expect(toolCommandType(tc('READ_FILE'))).toBe('read');
    expect(toolCommandType(tc('replace-file-content'))).toBe('edit');
  });

  it('write/edit 互斥：write_edit 类名归 edit', () => {
    expect(toolCommandType(tc('write_edit_plan'))).toBe('edit');
  });
});

describe('toolCommandIcon（最小 kind→图标表）', () => {
  it('每个 kind 恰有一个图标映射（无缺漏）', () => {
    const kinds: ToolCommandKind[] = [
      'shell',
      'network',
      'mcp',
      'task',
      'read',
      'write',
      'edit',
      'workspace',
      'delete',
      'list',
      'search',
      'subagent',
      'timer',
      'note',
      'misc',
    ];
    for (const k of kinds) {
      expect(TOOL_COMMAND_ICONS[k], `kind=${k}`).toBeTypeOf('string');
    }
  });

  it('toolCommandIcon(kind) 返回对应表项；未知 kind 走 wrench 兜底', () => {
    expect(toolCommandIcon('shell')).toBe(TOOL_COMMAND_ICONS.shell);
    expect(toolCommandIcon('misc')).toBe(TOOL_COMMAND_ICONS.misc);
    expect(toolCommandIcon('unknown' as ToolCommandKind)).toBe(
      TOOL_COMMAND_ICONS.misc
    );
  });
});
