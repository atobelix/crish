import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackgroundCommandManager,
  createBackgroundCommandTools,
} from './background-command';
import type { ToolExecutionContext } from '@crish/shared-types';

let workspaceRoot = '';

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-bg-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function context(): ToolExecutionContext {
  return {
    toolCallId: 'call',
    sessionId: 'session',
    cwd: workspaceRoot,
    signal: new AbortController().signal,
    emit: () => undefined,
  };
}

describe('background command manager', () => {
  it('starts a real command, tracks output, and resolves when it finishes', async () => {
    await writeFile(
      join(workspaceRoot, 'bg-test.js'),
      'setTimeout(() => console.log("后台中文完成"), 30);',
      'utf8'
    );
    const events: string[] = [];
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 5_000,
      maxOutputBytes: 20_000,
    });
    manager.subscribe((event) => events.push(event.type));

    const started = await manager.start({ command: 'node bg-test.js' });
    const finished = await manager.waitForTask(started.id, 5_000);

    expect(started.state).toBe('running');
    expect(finished).toMatchObject({
      id: started.id,
      state: 'succeeded',
      exitCode: 0,
    });
    expect(finished.outputPreview).toContain('后台中文完成');
    expect(events).toContain('task-start');
    expect(events).toContain('task-output');
    expect(events).toContain('task-end');
  });

  it('propagates native command exit codes through the shell wrapper', async () => {
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 5_000,
    });

    const started = await manager.start({
      command: 'node -e "process.exit(7)"',
    });
    const finished = await manager.waitForTask(started.id, 5_000);

    expect(finished).toMatchObject({
      id: started.id,
      state: 'failed',
      exitCode: 7,
    });
  });

  it('marks timed-out background commands with lifecycle metadata and diagnostics', async () => {
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 100,
    });

    const started = await manager.start({
      command: 'node -e "setTimeout(() => {}, 30000)"',
      timeoutMs: 1_000,
    });
    const finished = await manager.waitForTask(started.id, 5_000);

    expect(finished).toMatchObject({
      id: started.id,
      state: 'timed-out',
      timedOut: true,
      cancelled: false,
    });
    expect(finished.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(finished.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(finished.terminationDiagnostics.length).toBeGreaterThan(0);
    expect(finished.terminationDiagnostics[0]).toMatchObject({
      ok: expect.any(Boolean),
    });
  }, 10_000);

  it('keeps background output bounded while preserving byte counts', async () => {
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 5_000,
      maxOutputBytes: 1_500,
    });

    const started = await manager.start({
      command: 'node -e "process.stdout.write(\'b\'.repeat(9000))"',
    });
    const finished = await manager.waitForTask(started.id, 5_000);

    expect(finished).toMatchObject({
      state: 'succeeded',
      truncated: true,
      stdoutBytes: 9000,
    });
    expect(finished.stdoutPreview.length).toBeLessThan(3000);
    expect(finished.stdoutPreview).toContain('[output omitted:');
    expect(finished.outputPreview).toContain('[output omitted:');
  });

  it('emits heartbeat events for silent long-running commands', async () => {
    const events: string[] = [];
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 5_000,
      heartbeatIntervalMs: 1_000,
    });
    manager.subscribe((event) => events.push(event.type));

    const started = await manager.start({
      command: 'node -e "setTimeout(() => {}, 1200)"',
    });
    const finished = await manager.waitForTask(started.id, 5_000);

    expect(finished.state).toBe('succeeded');
    expect(events).toContain('task-heartbeat');
    expect(events.at(-1)).toBe('task-end');
  });

  it('exposes clear AI tools: run_background, wait_for_task, check_task, list_tasks, stop_task', async () => {
    await writeFile(
      join(workspaceRoot, 'bg-tool.js'),
      "setTimeout(() => console.log('done'), 30000);",
      'utf8'
    );
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 5_000,
    });
    const tools = createBackgroundCommandTools(manager);
    const start = tools.find((tool) => tool.name === 'run_background')!;
    const get = tools.find((tool) => tool.name === 'check_task')!;
    const wait = tools.find((tool) => tool.name === 'wait_for_task')!;
    const list = tools.find((tool) => tool.name === 'list_tasks')!;
    const cancel = tools.find((tool) => tool.name === 'stop_task')!;

    expect(wait).toBeTruthy();

    const startOutput = await start.execute(
      { command: 'node bg-tool.js' },
      context()
    );
    const taskId = (startOutput.json as { id: string }).id;
    expect(startOutput.text).toMatch(/后台|启动|提示/);
    const getOutput = await get.execute({ taskId }, context());
    const listOutput = await list.execute({}, context());
    const cancelOutput = await cancel.execute({ taskId }, context());
    const cancelled = await manager.waitForTask(taskId, 5_000);

    expect(getOutput.text).toContain(taskId);
    expect(listOutput.text).toContain(taskId);
    expect(cancelOutput.text).toContain(taskId);
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      cancelled: true,
      timedOut: false,
      exitCode: null,
      signal: 'cancelled',
    });
    expect(cancelled.terminationDiagnostics.length).toBeGreaterThan(0);
  }, 15_000);

  it('wait_for_task soft-timeout does not cancel a still-running process', async () => {
    await writeFile(
      join(workspaceRoot, 'slow.js'),
      "setTimeout(() => console.log('late'), 2000);",
      'utf8'
    );
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 30_000,
    });
    const tools = createBackgroundCommandTools(manager);
    const start = tools.find((tool) => tool.name === 'run_background')!;
    const wait = tools.find((tool) => tool.name === 'wait_for_task')!;
    const started = await start.execute({ command: 'node slow.js' }, context());
    const taskId = (started.json as { id: string }).id;
    const waited = await wait.execute({ taskId, timeoutMs: 80 }, context());
    expect((waited.json as { state: string }).state).toBe('running');
    expect(waited.text).toMatch(/仍在运行|未/);
    const finished = await manager.waitForTask(taskId, 10_000);
    expect(finished.state).toBe('succeeded');
  }, 20_000);

  it('blocks hardline commands below the approval layer', async () => {
    const manager = new BackgroundCommandManager({ workspaceRoot });

    await expect(manager.start({ command: 'shutdown /s' })).rejects.toThrow(
      /hardline|shutdown|reboot/i
    );
  });
});
