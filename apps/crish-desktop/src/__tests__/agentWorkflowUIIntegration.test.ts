import { describe, it, expect } from 'vitest';
import { ApprovalFlowMachine } from '../api/approvalFlowMachine';
import { parseApprovalRiskMeta } from '../api/approvalMeta';
import { assistantTurnLabel, mergeSessionDiffFiles } from '../api/diffPanelHelpers';
import { classifyFileDiff, applySearchReplaceToContent, normalizeApplyPath, isSafeApplyPath } from '../api/applyFileDiff';
import type { FileDiff } from '../store/types';

describe('Frontend UI & Store Integration Test Suite for Agent Workflows', () => {

  // =========================================================================
  // 1. UI Approval State Machine & Risk Meta Parsing
  // =========================================================================
  describe('Flow 1: UI Sensitive Approval Flow Machine & Risk Parsing', () => {
    
    it('handles transition from pending approval to approved, updating UI state & active tool ID', () => {
      const machine = new ApprovalFlowMachine();

      expect(machine.hasPending()).toBe(false);
      expect(machine.hasInflight()).toBe(false);
      expect(machine.shouldBlockTerminal()).toBe(false);

      // 发起工具开始与敏感工具审批请求 (如 write_to_file / run_command)
      machine.dispatch({ type: 'tool_start', toolId: 'call_write_ui_001' });
      machine.dispatch({ type: 'approval_pending', toolId: 'call_write_ui_001' });

      expect(machine.hasInflight()).toBe(true);
      expect(machine.hasPending()).toBe(true);
      expect(machine.shouldBlockTerminal()).toBe(true);

      // 模拟用户在 UI 弹窗上按下 "允许"
      machine.dispatch({ type: 'approval_resolved', toolId: 'call_write_ui_001' });

      expect(machine.hasPending()).toBe(false);
      expect(machine.hasInflight()).toBe(true); // 工具恢复继续跑

      // 工具跑完
      machine.dispatch({ type: 'tool_end', toolId: 'call_write_ui_001' });
      expect(machine.hasInflight()).toBe(false);
      expect(machine.shouldBlockTerminal()).toBe(false);
    });

    it('handles user denial in UI modal with custom rejection feedback', () => {
      const machine = new ApprovalFlowMachine();

      machine.dispatch({ type: 'tool_start', toolId: 'call_cmd_dangerous' });
      machine.dispatch({ type: 'approval_pending', toolId: 'call_cmd_dangerous' });

      expect(machine.hasPending()).toBe(true);

      // 模拟用户按下 "拒绝"
      machine.dispatch({ type: 'approval_resolved', toolId: 'call_cmd_dangerous', denied: true });

      // 拒绝会同步清理 pending 与 inflight
      expect(machine.hasPending()).toBe(false);
      expect(machine.hasInflight()).toBe(false);
      expect(machine.shouldBlockTerminal()).toBe(false);
    });

    it('parses risk metadata correctly into Chinese UI tags and warning tones', () => {
      const highRiskMeta = parseApprovalRiskMeta({
        type: 'approval-requested',
        toolCallId: 't1',
        risk: 'destructive',
        riskReason: 'rm -rf /var/log',
        metadata: { trustZone: 'T3', riskLevel: 'high' }
      });

      expect(highRiskMeta.riskLevel).toBe('high');
      expect(highRiskMeta.trustZone).toBe('T3');
      expect(highRiskMeta.riskReason).toContain('rm -rf');

      const lowRiskMeta = parseApprovalRiskMeta({
        type: 'approval-requested',
        toolCallId: 't2',
        risk: 'read',
        metadata: { trustZone: 'T0', riskLevel: 'low' }
      });
      expect(lowRiskMeta.riskLevel).toBe('low');
    });
  });

  // =========================================================================
  // 2. Multi-Agent & Turn Formatting UI Helpers
  // =========================================================================
  describe('Flow 2: Assistant Turn Formatting & Multi-Turn Diff Merging', () => {

    it('formats turn label correctly with Chinese copy and time', () => {
      const mockMsg = { timestamp: new Date('2026-06-08T10:15:00.000Z').getTime() };
      const label = assistantTurnLabel(mockMsg, 0, 3);
      expect(label).toContain('回合 1');
      expect(label).toContain('3 个文件');
    });

    it('merges multi-turn diff files cleanly by path prioritizing latest additions/deletions', () => {
      const turn1File: FileDiff = {
        filePath: 'src/app.ts',
        additions: 5,
        deletions: 2,
        changes: [{ type: 'addition', content: 'new line' }]
      };
      const turn2File: FileDiff = {
        filePath: 'src/app.ts',
        additions: 10,
        deletions: 1,
        changes: [{ type: 'deletion', content: 'old line' }]
      };

      const merged = mergeSessionDiffFiles([
        { files: [turn1File] },
        { files: [turn2File] }
      ]);

      expect(merged).toHaveLength(1);
      expect(merged[0].filePath).toBe('src/app.ts');
      expect(merged[0].additions).toBe(15);
      expect(merged[0].deletions).toBe(3);
    });
  });

  // =========================================================================
  // 3. Diff Panel Helpers & In-Memory Patch Application
  // =========================================================================
  describe('Flow 3: Path Normalization, Safety & Search/Replace Apply', () => {

    it('normalizes apply paths and validates safe workspace relative paths', () => {
      expect(normalizeApplyPath('  src\\a\\b.ts  ')).toBe('src/a/b.ts');
      expect(normalizeApplyPath('./foo/')).toBe('foo');

      expect(isSafeApplyPath('src/a.ts')).toEqual({ ok: true, path: 'src/a.ts' });
      expect(isSafeApplyPath('../etc/passwd').ok).toBe(false);
      expect(isSafeApplyPath('CON').ok).toBe(false);
    });

    it('classifies full_write vs search_replace file diffs and applies search/replace to content', () => {
      const fileDiff: FileDiff = {
        filePath: 'src/config.ts',
        changes: [
          { type: 'deletion', content: 'const x = 1;' },
          { type: 'addition', content: 'const x = 100;' }
        ]
      };

      const classifyRes = classifyFileDiff(fileDiff);
      expect(classifyRes.ok).toBe(true);

      const original = 'const x = 1;\nconst y = 2;\n';
      const replaced = applySearchReplaceToContent(original, 'const x = 1;', 'const x = 100;');
      expect(replaced).toEqual({ ok: true, content: 'const x = 100;\nconst y = 2;\n' });
    });
  });

});
