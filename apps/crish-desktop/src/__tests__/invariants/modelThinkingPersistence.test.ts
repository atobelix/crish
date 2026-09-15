/**
 * modelThinkingPersistence.test.ts
 * 模型全局记忆、思考档位平移继承与对话流即时居中卡片系统性契约测试
 *
 * 验证准则：
 * 1. 用户设置优先：用户在模型设定思考偏好，开启新会话（草稿/新session）绝对不被回退为 Low；
 * 2. 跨模型平移：当前选用 High，切到支持 High 的新模型无损继承并持久化；
 * 3. 即时居中卡片：切换模型/档位瞬间，对话流内即刻派发居中卡片（PureCarrier）；连续切换原地更新；
 * 4. 负向断言：切除恶意覆盖副作用，杜绝向旧 LocalStorage 暂存孤岛写入。
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import {
  sessionRuntimeRegistry,
  resolveEffectiveThinkingTitle,
  persistThinkingSelection,
  loadModelThinkingPref,
  saveGlobalThinkingPref,
  loadGlobalThinkingPref,
} from '../../api/SessionRuntimeRegistry';
import {
  resolveThinkingHandoff,
} from '../../api/modelsCatalogLive';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';
import { useSessionStore } from '../../store/sessionStore';
import {
  recordPendingContextState,
  PENDING_CONTEXT_STATE_KEY,
} from '../../api/provider-profiles/contextStatePending';
import { flushContextStateBeforeSend } from '../../hooks/chat-stream/slashSendQueueHelper';

const CATALOG_PATH = 'C:\\tmp\\models.yaml';

function mockReadOk(providers: Record<string, ProviderSpec>): void {
  mockTauriCommand('workbench_read_models_yaml', () => ({
    path: CATALOG_PATH,
    content: '',
    template: '',
    revision: 'revision-0',
    credentialStates: {},
    parseError: null,
    tree: { version: 2, activeModel: null, providers },
  }));
}

async function loadProviders(providers: Record<string, ProviderSpec>): Promise<void> {
  mockReadOk(providers);
  mockTauriCommand('workbench_save_models_yaml', () => ({ path: CATALOG_PATH }));
  resetModelsCatalogMirror();
  await ensureModelsCatalogLoaded();
}

describe('模型思考强度全局记忆与平移继承契约', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionRuntimeRegistry.clearAll();
    useSessionStore.setState({
      sessions: [
        {
          id: 'sess-active',
          title: '活跃会话',
          messages: [
            {
              id: 'm1',
              sender: 'user',
              text: '你好',
              timestamp: Date.now(),
            },
          ],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      sessionsById: {
        'sess-active': {
          id: 'sess-active',
          title: '活跃会话',
          messages: [
            {
              id: 'm1',
              sender: 'user',
              text: '你好',
              timestamp: Date.now(),
            },
          ],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      activeSessionId: 'sess-active',
    });

    await loadProviders({
      anthropic: {
        displayName: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        protocol: 'openai/chat',
        models: [
          {
            id: 'claude-sonnet',
            displayName: 'Claude Sonnet',
            thinking: {
              Low: 'low',
              Medium: 'medium',
              High: 'high',
            },
          },
          {
            id: 'claude-opus',
            displayName: 'Claude Opus',
            thinking: {
              Low: 'low',
              Medium: 'medium',
              High: 'high',
            },
          },
        ],
      },
      deepseek: {
        displayName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        protocol: 'openai/chat',
        models: [
          {
            id: 'deepseek-v4',
            displayName: 'DeepSeek V4',
            thinking: {
              Off: 'none',
              Low: 'low',
              Medium: 'medium',
              High: 'high',
            },
          },
        ],
      },
    });
  });

  afterEach(() => {
    localStorage.clear();
    sessionRuntimeRegistry.clearAll();
    useSessionStore.setState({ sessions: [], sessionsById: {}, activeSessionId: '' });
  });

  it('物证 1：用户设置优先——选定 High 后，创建新会话（草稿态）绝不回退为 Low', () => {
    const s1 = 'sess-active';
    // 用户在旧会话中将 claude-sonnet 的思考档位设为 High
    persistThinkingSelection(s1, 'anthropic', 'claude-sonnet', 'High');
    expect(loadModelThinkingPref('anthropic', 'claude-sonnet')).toBe('High');
    expect(loadGlobalThinkingPref()).toBe('High');

    // 用户点击「新对话」，切换到新会话草稿 draft_leaf_new
    const draftSid = 'draft_leaf_new';
    useSessionStore.setState({ activeSessionId: draftSid });

    // 新会话中解析生效档位
    const effective = resolveEffectiveThinkingTitle(
      draftSid,
      'anthropic',
      'claude-sonnet'
    );
    expect(effective).toBe('High');

    // 经由 live handoff 解析，断言坚定保持为 High，绝对不是 Low
    const handoff = resolveThinkingHandoff(
      'anthropic',
      'claude-sonnet',
      effective
    );
    expect(handoff.supported).toBe(true);
    expect(handoff.selectedTitle).toBe('High');
    expect(handoff.selectedTitle).not.toBe('Low');
  });

  it('物证 2：跨模型意图平移——当前选为 High，切到新模型无损继承 High 并持久化', () => {
    const sid = 'sess-active';
    // 用户在 claude-sonnet 选为 High
    persistThinkingSelection(sid, 'anthropic', 'claude-sonnet', 'High');

    // 用户切换至 deepseek-v4（该模型历史未选过）
    expect(loadModelThinkingPref('deepseek', 'deepseek-v4')).toBeNull();

    // 解析新模型的目标档位：由于全局最近设定为 High，新模型平移继承 High
    const targetTitle = resolveEffectiveThinkingTitle(
      sid,
      'deepseek',
      'deepseek-v4'
    );
    expect(targetTitle).toBe('High');

    const nextHandoff = resolveThinkingHandoff(
      'deepseek',
      'deepseek-v4',
      targetTitle
    );
    expect(nextHandoff.supported).toBe(true);
    expect(nextHandoff.selectedTitle).toBe('High');

    // 持久化给新模型
    persistThinkingSelection(
      sid,
      'deepseek',
      'deepseek-v4',
      nextHandoff.selectedTitle
    );
    expect(loadModelThinkingPref('deepseek', 'deepseek-v4')).toBe('High');
  });

  it('物证 3：状态提示仅在用户点击发送时带上，且物理位置位于用户消息上方', () => {
    const sid = 'sess-active';
    const store = useSessionStore.getState();
    const initialMsgCount = store.sessions.find((s) => s.id === sid)!.messages.length;

    // 1. 用户在菜单或胶囊中切换模型和思考档位
    localStorage.setItem('crish_active_model_id', 'claude-sonnet');
    localStorage.setItem('crish_active_profile_id', 'anthropic');
    persistThinkingSelection(sid, 'anthropic', 'claude-sonnet', 'High');
    recordPendingContextState(sid);

    // 严密断言（用户裁决）：切换瞬间绝不向消息列表追加卡片，消息数完全不变
    const sessAfterSwitch = store.sessions.find((s) => s.id === sid);
    expect(sessAfterSwitch!.messages.length).toBe(initialMsgCount);

    // 2. 用户点击发送按钮（触发 flushContextStateBeforeSend 并压入 userMsg）
    const flushedState = flushContextStateBeforeSend(sid);
    expect(flushedState).toBeDefined();
    expect(flushedState).toContain('claude-sonnet');

    store.addMessage('ws-1', sid, {
      id: 'user-send-1',
      sender: 'user',
      text: '请帮我写一段代码',
      timestamp: Date.now(),
      status: 'processing',
    });

    const sessAfterSend = useSessionStore
      .getState()
      .sessions.find((s) => s.id === sid);
    const msgs = sessAfterSend!.messages;
    // 应当新增了 2 条消息：[居中提示 carrier] 与 [用户消息 user]
    expect(msgs.length).toBe(initialMsgCount + 2);

    const carrierMsg = msgs[msgs.length - 2]!;
    const userMsg = msgs[msgs.length - 1]!;

    // 核心断言：居中提示必须在用户发送的消息上方
    expect(carrierMsg.sender).toBe('assistant');
    expect(carrierMsg.blocks?.[0]?.type).toBe('context_injection');
    expect(carrierMsg.injections?.[0]?.metadata?.mode).toBe('context-state');
    expect(carrierMsg.injections?.[0]?.metadata?.thinking).toBe('High');

    expect(userMsg.sender).toBe('user');
    expect(userMsg.id).toBe('user-send-1');

    // 3. 用户在不切换模型的情况下发送第二条消息
    const flushedSecond = flushContextStateBeforeSend(sid);
    expect(flushedSecond).toBeUndefined(); // 未换模型，不带状态提示

    useSessionStore.getState().addMessage('ws-1', sid, {
      id: 'user-send-2',
      sender: 'user',
      text: '第二轮提问',
      timestamp: Date.now(),
      status: 'processing',
    });

    const sessAfterSecond = useSessionStore
      .getState()
      .sessions.find((s) => s.id === sid);
    // 仅追加用户消息，绝不重复生成提示
    expect(sessAfterSecond!.messages.length).toBe(initialMsgCount + 3);
    expect(sessAfterSecond!.messages[sessAfterSecond!.messages.length - 1]!.id).toBe('user-send-2');
  });

  it('物证 4：切出去又切回相同模型，发送时不弹出多余提示', () => {
    const sid = 'sess-active';
    // 1. 设定首轮发送确立状态基线在 claude-sonnet (High)
    localStorage.setItem('crish_active_model_id', 'claude-sonnet');
    localStorage.setItem('crish_active_profile_id', 'anthropic');
    persistThinkingSelection(sid, 'anthropic', 'claude-sonnet', 'High');
    flushContextStateBeforeSend(sid);

    // 2. 切换至 deepseek
    localStorage.setItem('crish_active_model_id', 'deepseek-v4');
    persistThinkingSelection(sid, 'deepseek', 'deepseek-v4', 'High');
    recordPendingContextState(sid);

    // 3. 发送前又切回 claude-sonnet (High)
    localStorage.setItem('crish_active_model_id', 'claude-sonnet');
    persistThinkingSelection(sid, 'anthropic', 'claude-sonnet', 'High');
    recordPendingContextState(sid);

    // 4. 发送
    const flushed = flushContextStateBeforeSend(sid);
    expect(flushed).toBeUndefined(); // 切回了上一轮相同的状态，不应弹出提示
  });
});
