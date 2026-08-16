import { describe, it, expect } from 'vitest';
import {
  parseToolArgsSafe,
  extractToolCommand,
  extractToolCwd,
  humanizeShellCommand,
  toolLabelFromArgs,
  toolHumanLabel,
  sanitizeHumanLabel,
  toolCommandPreview,
  fullToolOutput,
  truncateToolOutput,
  toolDiffLineStats,
  formatToolDiffStat,
  toolHasDiffStat,
  toolHasExpandableBody,
  isInspectTool,
  toolRowTone,
  extractImageRefs,
  humanizeAgentSummary,
  assistantCopyText,
  isPlaceholderToolOutput,
  isTrivialToolOutput,
} from './toolCardPresenter';
import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';

describe('DIM-05 / Batch 3 工具卡片语义化与防逃逸测试套件', () => {
  describe('1. parseToolArgsSafe & extractToolCommand 深度解包测试', () => {
    it('应能正确解析 PascalCase 参数 (Antigravity 格式)', () => {
      const res = parseToolArgsSafe(
        JSON.stringify({
          CommandLine: 'npm run test',
          Cwd: 'C:/Software/conex',
        })
      );
      expect(res.isObject).toBe(true);
      expect(res.primaryTarget).toBe('npm run test');
      expect(res.props.cwd).toBe('C:/Software/conex');
      expect(extractToolCwd(JSON.stringify({ Cwd: 'C:/Software/conex' }))).toBe(
        'C:/Software/conex'
      );
      expect(
        extractToolCommand(JSON.stringify({ CommandLine: 'npm run test' }))
      ).toBe('npm run test');
    });

    it('应能正确解析 snake_case 参数 (Conex 内核格式)', () => {
      const res = parseToolArgsSafe(
        JSON.stringify({ command_line: 'cargo test', task_id: 'task-0' })
      );
      expect(res.isObject).toBe(true);
      expect(res.primaryTarget).toBe('cargo test');
      expect(res.props.task_id).toBe('task-0');
    });

    it('应能解开双重编码的 JSON 字符串', () => {
      const inner = JSON.stringify({ action: 'status', taskId: 'task-10' });
      const doubleEncoded = JSON.stringify(inner);
      const res = parseToolArgsSafe(doubleEncoded);
      expect(res.isObject).toBe(true);
      expect(res.props.taskid).toBe('task-10');
    });

    it('面对空对象或未匹配主键时 extractToolCommand 严禁返回 raw JSON', () => {
      expect(extractToolCommand('{}')).toBe('');
      expect(extractToolCommand('{"unknownKey":"someValue"}')).toBe('');
      expect(extractToolCommand('{"action":"status","taskId":"task-0"}')).toBe(
        'task-0'
      );
    });

    it('支持嵌套 parameters / input / Arguments 解包', () => {
      const wrapped = JSON.stringify({
        parameters: { TargetFile: 'src/App.tsx' },
      });
      const res = parseToolArgsSafe(wrapped);
      expect(res.primaryTarget).toBe('src/App.tsx');

      const wrappedInput = JSON.stringify({
        input: { AbsolutePath: 'C:/Software/conex/Cargo.toml' },
      });
      expect(parseToolArgsSafe(wrappedInput).primaryTarget).toBe(
        'C:/Software/conex/Cargo.toml'
      );

      const mcpArgs = JSON.stringify({
        Arguments: { Query: 'toolCardPresenter' },
      });
      expect(parseToolArgsSafe(mcpArgs).primaryTarget).toBe(
        'toolCardPresenter'
      );
    });

    it('面对 null 或空字符串安全返回', () => {
      expect(parseToolArgsSafe(null).isObject).toBe(false);
      expect(parseToolArgsSafe('').isObject).toBe(false);
      expect(extractToolCommand('')).toBe('');
    });
  });

  describe('2. humanizeShellCommand 智能意图翻译测试', () => {
    it('包管理器命令翻译', () => {
      expect(humanizeShellCommand('npm install lodash')).toBe(
        '安装依赖 lodash'
      );
      expect(humanizeShellCommand('pnpm i')).toBe('安装项目依赖');
      expect(humanizeShellCommand('npm add react')).toBe('添加依赖 react');
      expect(humanizeShellCommand('npm run build')).toBe('构建项目');
      expect(humanizeShellCommand('npm run dev')).toBe('启动开发服务');
      expect(humanizeShellCommand('npm run test:coverage')).toBe(
        '运行测试 (test:coverage)'
      );
      expect(humanizeShellCommand('npm run lint')).toBe('检查代码规范');
      expect(humanizeShellCommand('npm run typecheck')).toBe('检查代码类型');
      expect(humanizeShellCommand('npx vitest')).toBe('运行工具 vitest');
      expect(humanizeShellCommand('pnpm dlx rimraf dist')).toBe(
        '运行工具 rimraf'
      );
      expect(humanizeShellCommand('bun add tailwindcss')).toBe(
        '添加依赖 tailwindcss'
      );
      expect(humanizeShellCommand('bun x prisma generate')).toBe(
        '运行工具 prisma'
      );
    });

    it('Cargo 与 Rust 命令翻译', () => {
      expect(humanizeShellCommand('cargo test --workspace')).toBe(
        '运行 Rust 测试'
      );
      expect(humanizeShellCommand('cargo check')).toBe('检查 Rust 编译');
      expect(humanizeShellCommand('cargo clippy')).toBe('运行 Clippy 审查');
      expect(humanizeShellCommand('cargo build --release')).toBe(
        '构建 Rust 项目'
      );
      expect(humanizeShellCommand('cargo run')).toBe('运行 Rust 程序');
      expect(humanizeShellCommand('cargo fmt')).toBe('格式化 Rust 代码');
      expect(humanizeShellCommand('cargo add serde')).toBe('添加 Rust 依赖');
    });

    it('Git 版本控制翻译', () => {
      expect(humanizeShellCommand('git status')).toBe('查看代码变更状态');
      expect(humanizeShellCommand('git diff HEAD~1')).toBe('查看文件差异');
      expect(humanizeShellCommand('git log -n 5')).toBe('查看提交历史');
      expect(humanizeShellCommand('git commit -m "feat"')).toBe(
        '创建 Git 提交'
      );
      expect(humanizeShellCommand('git add .')).toBe('暂存代码改动');
      expect(humanizeShellCommand('git push origin main')).toBe(
        '推送到远程仓库'
      );
      expect(humanizeShellCommand('git pull')).toBe('拉取远程更新');
      expect(humanizeShellCommand('git checkout dev')).toBe('切换 Git 分支');
      expect(humanizeShellCommand('git branch -a')).toBe('查看或管理分支');
      expect(humanizeShellCommand('git stash pop')).toBe('贮藏工作区改动');
    });

    it('PowerShell 包装与管道处理', () => {
      expect(humanizeShellCommand('powershell.exe -Command "cargo test"')).toBe(
        '运行 Rust 测试'
      );
      expect(humanizeShellCommand('pwsh -c "npm run test"')).toBe(
        '运行测试 (test)'
      );
      expect(
        humanizeShellCommand('cd C:/Software/conex && npm run build')
      ).toBe('构建项目');
    });

    it('基础文件与查找命令翻译', () => {
      expect(humanizeShellCommand('ls -la')).toBe('列出目录内容');
      expect(humanizeShellCommand('dir /s')).toBe('列出目录内容');
      expect(humanizeShellCommand('cat README.md')).toBe('查看 README.md');
      expect(humanizeShellCommand('rg "toolCard"')).toBe('搜索「toolCard」');
      expect(humanizeShellCommand('go test ./...')).toBe('运行 Go 测试');
      expect(humanizeShellCommand('dotnet build')).toBe('构建 .NET 项目');
      expect(humanizeShellCommand('make test')).toBe('执行 Make 构建');
    });
  });

  describe('3. 13 类工具精准中文语义标题生成测试', () => {
    it('1. Shell 类工具 (run_command, shell, pwsh)', () => {
      const tc: MessageToolCall = {
        id: 't-1',
        name: 'run_command',
        arguments: JSON.stringify({ CommandLine: 'cargo test' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(tc)).toBe('运行 Rust 测试');
      expect(toolHumanLabel(tc)).toBe('运行 Rust 测试');
    });

    it('2. 后台任务管理 (manage_task)', () => {
      const listCall: MessageToolCall = {
        id: 't-2',
        name: 'manage_task',
        arguments: JSON.stringify({ Action: 'list' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(listCall)).toBe('查询后台任务列表');

      const statusCall: MessageToolCall = {
        id: 't-3',
        name: 'manage_task',
        arguments: JSON.stringify({ Action: 'status', TaskId: 'task-0' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(statusCall)).toBe('查询后台任务 (task-0)');

      const killCall: MessageToolCall = {
        id: 't-4',
        name: 'manage_task',
        arguments: JSON.stringify({ Action: 'kill', TaskId: 'task-1' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(killCall)).toBe('终止后台任务 (task-1)');
    });

    it('3. 文件读取 / 查阅 (view_file, read_file)', () => {
      const tc: MessageToolCall = {
        id: 't-5',
        name: 'view_file',
        arguments: JSON.stringify({
          AbsolutePath: 'C:/Software/conex/src/main.rs',
          StartLine: 10,
          EndLine: 50,
        }),
        status: 'success',
      };
      expect(toolLabelFromArgs(tc)).toBe('查看 main.rs (L10-50)');
    });

    it('4. 文件写入 / 创建 (write_to_file)', () => {
      const tc: MessageToolCall = {
        id: 't-6',
        name: 'write_to_file',
        arguments: JSON.stringify({
          TargetFile: 'src/index.ts',
          CodeContent: 'export {}',
        }),
        status: 'success',
      };
      expect(toolLabelFromArgs(tc)).toBe('写入 index.ts');
    });

    it('5. 文件编辑 / 代码替换 (replace_file_content, multi_replace)', () => {
      const single: MessageToolCall = {
        id: 't-7',
        name: 'replace_file_content',
        arguments: JSON.stringify({ TargetFile: 'App.tsx' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(single)).toBe('修改 App.tsx');

      const multi: MessageToolCall = {
        id: 't-8',
        name: 'multi_replace_file_content',
        arguments: JSON.stringify({ TargetFile: 'App.tsx' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(multi)).toBe('批量修改 App.tsx');
    });

    it('6. 目录浏览 (list_dir) - 彻底消灭「浏览 {}」与「处理 .」', () => {
      const emptyArgs: MessageToolCall = {
        id: 't-9',
        name: 'list_dir',
        arguments: '{}',
        status: 'success',
      };
      expect(toolLabelFromArgs(emptyArgs)).toBe('列出当前目录');
      expect(toolHumanLabel(emptyArgs)).toBe('列出当前目录');

      const dotArgs: MessageToolCall = {
        id: 't-10',
        name: 'list_dir',
        arguments: JSON.stringify({ DirectoryPath: '.' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(dotArgs)).toBe('列出当前目录');

      const dirArgs: MessageToolCall = {
        id: 't-11',
        name: 'list_dir',
        arguments: JSON.stringify({ DirectoryPath: 'src/components' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(dirArgs)).toBe('列出目录 components');
    });

    it('7. 代码与文本搜索 (grep_search)', () => {
      const tc: MessageToolCall = {
        id: 't-12',
        name: 'grep_search',
        arguments: JSON.stringify({
          Query: 'toolCardPresenter',
          SearchPath: 'src',
        }),
        status: 'success',
      };
      expect(toolLabelFromArgs(tc)).toBe('在 src 搜索「toolCardPresenter」');
    });

    it('8. 多 Agent 协作 (invoke_subagent, run_subagent, send_message)', () => {
      const subagentCall: MessageToolCall = {
        id: 't-13',
        name: 'invoke_subagent',
        arguments: JSON.stringify({ Role: '架构分析师' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(subagentCall)).toBe('启动子代理：架构分析师');

      const sendCall: MessageToolCall = {
        id: 't-14',
        name: 'send_message',
        arguments: JSON.stringify({ Recipient: 'subagent-0' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(sendCall)).toBe('向 subagent-0 发送消息');
    });

    it('9. 定时器与计划 (schedule, set_timer, cancel_timer)', () => {
      const timerCall: MessageToolCall = {
        id: 't-15',
        name: 'schedule',
        arguments: JSON.stringify({ DurationSeconds: 100 }),
        status: 'success',
      };
      expect(toolLabelFromArgs(timerCall)).toBe('设置定时器 (100秒)');

      const cronCall: MessageToolCall = {
        id: 't-16',
        name: 'schedule',
        arguments: JSON.stringify({ CronExpression: '*/5 * * * *' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(cronCall)).toBe('设置定时任务 (*/5 * * * *)');

      const cancelCall: MessageToolCall = {
        id: 't-17',
        name: 'cancel_timer',
        arguments: JSON.stringify({ TaskId: 'task-99' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(cancelCall)).toBe('取消定时器 (task-99)');
    });

    it('10. 工作区产出与上下文 (resolve_output_dir, project_tree)', () => {
      const outCall: MessageToolCall = {
        id: 't-18',
        name: 'resolve_output_dir',
        arguments: JSON.stringify({ folder: '05-详案' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(outCall)).toBe('解析产出目录 (05-详案)');

      const treeCall: MessageToolCall = {
        id: 't-19',
        name: 'project_tree',
        arguments: '{}',
        status: 'success',
      };
      expect(toolLabelFromArgs(treeCall)).toBe('生成项目结构树');
    });

    it('11. 笔记知识库 (note_*)', () => {
      const noteQuery: MessageToolCall = {
        id: 't-20',
        name: 'note_query_blocks',
        arguments: JSON.stringify({ query: '架构规范' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(noteQuery)).toBe('查询笔记区块「架构规范」');
    });

    it('12. 安全删除 (delete_file, delete_dir)', () => {
      const delFile: MessageToolCall = {
        id: 't-21',
        name: 'delete_file',
        arguments: JSON.stringify({ path: 'temp.log' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(delFile)).toBe('删除文件 temp.log (移入回收站)');

      const delDir: MessageToolCall = {
        id: 't-22',
        name: 'delete_dir',
        arguments: JSON.stringify({ path: 'dist' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(delDir)).toBe('删除目录 dist (移入回收站)');
    });

    it('13. MCP 扩展服务 (call_mcp_tool, mcp_*)', () => {
      const mcpSummary: MessageToolCall = {
        id: 't-23',
        name: 'call_mcp_tool',
        arguments: JSON.stringify({ toolSummary: 'Directory analysis' }),
        status: 'success',
      };
      expect(toolLabelFromArgs(mcpSummary)).toBe('Directory analysis');

      const mcpTarget: MessageToolCall = {
        id: 't-24',
        name: 'call_mcp_tool',
        arguments: JSON.stringify({
          ServerName: 'tauri-mcp',
          ToolName: 'query_page',
        }),
        status: 'success',
      };
      expect(toolLabelFromArgs(mcpTarget)).toBe(
        '调用 MCP [tauri-mcp:query_page]'
      );
    });
  });

  describe('4. sanitizeHumanLabel 终极安全清洗锁测试', () => {
    it('拦截任何 raw JSON 字符穿透', () => {
      expect(
        sanitizeHumanLabel(
          '{"action":"status","taskId":"task-0"}',
          'manage_task'
        )
      ).toBe('调用 manage_task');
      expect(sanitizeHumanLabel('{}', 'list_dir')).toBe('调用 list_dir');
      expect(sanitizeHumanLabel('[]', 'tool')).toBe('调用 tool');
      expect(sanitizeHumanLabel('{"Query":"test"}', 'grep_search')).toBe(
        '调用 grep_search'
      );
    });

    it('替换点号路径与空占位', () => {
      expect(sanitizeHumanLabel('处理 .')).toBe('处理当前目录');
      expect(sanitizeHumanLabel('浏览 {}')).toBe('浏览当前目录');
      expect(sanitizeHumanLabel('列出目录 .')).toBe('列出当前目录');
    });

    it('清洗残留的大括号与双引号', () => {
      expect(sanitizeHumanLabel('查看 {"App.tsx"}')).toBe('查看 App.tsx');
    });
  });

  describe('5. 输出文本与预览处理', () => {
    it('fullToolOutput 洗净占位符与终态词', () => {
      expect(fullToolOutput('执行中…')).toBe('');
      expect(fullToolOutput('OK')).toBe('');
      expect(fullToolOutput('Done')).toBe('');
      expect(fullToolOutput('Hello World')).toBe('Hello World');
    });

    it('truncateToolOutput 截断多行输出', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join(
        '\n'
      );
      const truncated = truncateToolOutput(lines, 5, 2000);
      expect(truncated).toContain('…（共 30 行）');
    });

    it('isPlaceholderToolOutput 与 isTrivialToolOutput', () => {
      expect(isPlaceholderToolOutput('执行中…')).toBe(true);
      expect(isPlaceholderToolOutput('运行中')).toBe(true);
      expect(isPlaceholderToolOutput('output text')).toBe(false);

      expect(isTrivialToolOutput('完成')).toBe(true);
      expect(isTrivialToolOutput('failed')).toBe(true);
      expect(isTrivialToolOutput('Done')).toBe(true);
      expect(isTrivialToolOutput('real output')).toBe(false);
    });
  });

  describe('6. Diff 统计、Tone 与视图状态', () => {
    it('toolDiffLineStats 计算 structured diffs', () => {
      const tc: MessageToolCall = {
        id: 't-diff',
        name: 'replace_file_content',
        status: 'success',
        diffs: [
          {
            filePath: 'src/App.tsx',
            additions: 5,
            deletions: 2,
          },
        ],
      };
      const stats = toolDiffLineStats(tc);
      expect(stats).toEqual({ add: 5, del: 2 });
      expect(formatToolDiffStat(stats!)).toBe('+5 −2');
      expect(toolHasDiffStat(tc)).toBe(true);
    });

    it('toolRowTone 正确映射视觉状态', () => {
      expect(toolRowTone('running')).toBe('running');
      expect(toolRowTone('error')).toBe('error');
      expect(toolRowTone('pending_approval')).toBe('pending');
      expect(toolRowTone('success')).toBe('success');
      expect(toolRowTone(undefined)).toBe('idle');
    });

    it('isInspectTool 正确识别只读工具', () => {
      expect(
        isInspectTool({ id: '1', name: 'read_file', status: 'success' })
      ).toBe(true);
      expect(
        isInspectTool({ id: '2', name: 'grep_search', status: 'success' })
      ).toBe(true);
      expect(
        isInspectTool({
          id: '3',
          name: 'replace_file_content',
          status: 'success',
        })
      ).toBe(false);
      expect(
        isInspectTool({
          id: '4',
          name: 'run_command',
          arguments: JSON.stringify({ CommandLine: 'git status' }),
          status: 'success',
        })
      ).toBe(true);
      expect(
        isInspectTool({
          id: '5',
          name: 'run_command',
          arguments: JSON.stringify({ CommandLine: 'npm install' }),
          status: 'success',
        })
      ).toBe(false);
    });

    it('toolHasExpandableBody 对有参数或有输出的调用返回 true', () => {
      expect(
        toolHasExpandableBody({
          id: '1',
          name: 'view_file',
          arguments: JSON.stringify({ AbsolutePath: 'src/main.rs' }),
          status: 'success',
        })
      ).toBe(true);
      expect(
        toolHasExpandableBody({
          id: '2',
          name: 'view_file',
          arguments: '',
          output: '',
          status: 'success',
        })
      ).toBe(false);
    });

    it('toolCommandPreview 提取简洁技术预览', () => {
      const tc: MessageToolCall = {
        id: '1',
        name: 'run_command',
        arguments: JSON.stringify({ CommandLine: 'git diff HEAD~1' }),
        status: 'success',
      };
      expect(toolCommandPreview(tc)).toBe('git diff HEAD~1');
    });

    it('extractImageRefs 提取图片 URL', () => {
      const text =
        'Check this: ![mockup](/path/to/img.png) and C:/test/pic.jpg';
      const imgs = extractImageRefs(text);
      expect(imgs.length).toBeGreaterThanOrEqual(1);
      expect(imgs[0]).toBe('/path/to/img.png');
    });

    it('humanizeAgentSummary 清洗摘要', () => {
      expect(humanizeAgentSummary('Task completed. All files fixed.')).toBe(
        'All files fixed.'
      );
      expect(humanizeAgentSummary('', 'running')).toBe('执行中…');
    });

    it('assistantCopyText 提取文本内容', () => {
      const msg: SessionMessage = {
        id: 'm1',
        sender: 'assistant',
        timestamp: Date.now(),
        text: 'Hello assistant text',
      };
      expect(assistantCopyText(msg)).toBe('Hello assistant text');
    });
  });
});
