/**
 * W3-F DOM 余量 · 与 collab Strict 写路径共存（jsdom）。
 *
 * **DOM 交付 ≠ EL-01**。**不得**因 DOM 回退 mock 默认。**≠** 占 SD-48。
 * 路径钉：`w3f_dom_collab_path_intact`（`createCollabApplySink`，非 mock.calls）。
 */
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { BlockChromeModel } from './BlockChrome';
import { BlockChromeDomHost } from './BlockChromeDomHost';
import {
  createCollabApplySink,
  submitIntent,
  type ApplyOpsAdapter,
} from '../leaves/intentBridge';
import { resetIntentIdSeqForTests } from '../intentId';
import { ID_A, ID_B, requireDocument } from './chrome.w3f_dom.harness';

describe('W3-F DOM · 与 collab Strict 共存', () => {
  it('w3f_dom_collab_path_intact: 多选删除仍走 createCollabApplySink（非 mock.calls）', async () => {
    resetIntentIdSeqForTests();
    const doc = requireDocument();
    const mount = doc.createElement('div');
    doc.body.appendChild(mount);

    const chrome = new BlockChromeModel({
      createIntentId: () => 'w3f-dom-del-collab',
    });
    const host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_A }, { blockId: ID_B }],
      chrome,
    });

    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson) => {
      applied.push(opsJson);
      return { ok: true };
    };
    const collab = createCollabApplySink({ applyOps });

    chrome.setMultiSelected([ID_A, ID_B]);
    host.sync();
    expect(host.isMultiCheckboxChecked(ID_A)).toBe(true);
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('multi');

    const del = chrome.requestDeleteSelected();
    expect(del.ok).toBe(true);
    if (!del.ok) return;

    const submitted = await submitIntent(del.intent, collab.sink);
    expect(submitted.ok).toBe(true);
    expect(collab.wireCalls).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('"op":"delete"');
    expect(applied[0]).toContain(ID_A);
    // 叙事：本路径无 mock.calls
    expect('calls' in collab).toBe(false);
    expect('wireCalls' in collab).toBe(true);

    host.sync();
    // 删除 Intent 成功后 model 清多选 → DOM 收敛
    expect(host.isMultiCheckboxChecked(ID_A)).toBe(false);
    expect(host.getHandleVisibilityAttr(ID_A)).toBe('hidden');

    host.destroy();
    mount.remove();
  });
});
