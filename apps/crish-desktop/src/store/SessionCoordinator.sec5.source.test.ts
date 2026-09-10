/**
 * §5.3：SessionCoordinator 销毁会话时清理 WorkflowConfirm 签名桶
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, './SessionCoordinator.ts');

describe('SessionCoordinator §5.3 signature cleanup', () => {
  it('calls clearWorkflowConfirmSignaturesForSession on cascade delete', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toMatch(/clearWorkflowConfirmSignaturesForSession/);
    expect(src).toMatch(/clearWorkflowConfirmSignaturesForSession\(id\)/);
  });
});
