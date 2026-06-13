/**
 * AskDeck - 交互式提问与待发送输入队列
 *
 * 包含两个组件：
 * - AskDeck: 展示 daemon 端发来的待回答问题
 * - PendingInputDeck: 展示已排队等待发送的用户输入
 */

import { useState, useEffect } from 'preact/hooks';
import { appState, type PendingAskQuestion, type PendingInputIntent } from '../../core/app-state';
import { tauriBridge } from '../../core/tauri-bridge';
import { formatTime } from '../utils';
import AskCard from '../AskCard';
import { IconClock, IconX } from '../icons';
import { showToast } from '../ToastContainer';

// ==================== AskDeck 组件（交互式提问） ====================

export function AskDeck() {
  const [questions, setQuestions] = useState<PendingAskQuestion[]>(appState.getState().pendingQuestions);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsub = appState.subscribe('pendingQuestions', (q) => setQuestions([...q]));
    setQuestions([...appState.getState().pendingQuestions]);
    return unsub;
  }, []);

  if (questions.length === 0) return null;
  const q = questions[0]!;

  const answer = async (questionId: string, value: string | string[]) => {
    setPending(p => ({ ...p, [questionId]: true }));
    try {
      await tauriBridge.answerQuestion(questionId, value, { runId: q.runId, sessionId: q.sessionId });
    } catch (error) {
      showToast('回答提问失败', 'error', 4500);
    } finally {
      setPending(p => ({ ...p, [questionId]: false }));
      appState.resolvePendingQuestion(questionId);
    }
  };

  return (
    <AskCard
      question={q}
      pending={pending[q.questionId]}
      onAnswer={(id, value) => void answer(id, value)}
      onCancel={(id) => void answer(id, '')}
    />
  );
}

// ==================== PendingInputDeck 组件 ====================

export function PendingInputDeck() {
  const [pendingInputs, setPendingInputs] = useState<PendingInputIntent[]>(() =>
    appState.getPendingInputs(appState.getCurrentSessionId())
  );

  useEffect(() => {
    const refresh = () => setPendingInputs(appState.getPendingInputs(appState.getCurrentSessionId()));
    const unsubInputs = appState.subscribe('pendingInputs', refresh);
    const unsubSession = appState.subscribe('currentSession', refresh);
    refresh();
    return () => {
      unsubInputs();
      unsubSession();
    };
  }, []);

  if (pendingInputs.length === 0) return null;

  const first = pendingInputs[0]!;
  const remainingCount = pendingInputs.length - 1;

  return (
    <div class="repl-pending-input-deck" role="status" aria-live="polite">
      <div class="repl-pending-input-main">
        <span class="repl-pending-input-icon"><IconClock /></span>
        <div class="repl-pending-input-copy">
          <div class="repl-pending-input-title">
            已排队，当前运行结束后发送
            {remainingCount > 0 && <span class="repl-pending-input-count">+{remainingCount}</span>}
          </div>
          <div class="repl-pending-input-text">{first.text}</div>
        </div>
      </div>
      <button
        type="button"
        class="repl-pending-input-remove"
        onClick={() => appState.removePendingInput(first.id)}
        title={`取消这条待发送输入，创建于 ${formatTime(first.createdAt)}`}
        aria-label="取消待发送输入"
      >
        <IconX />
      </button>
    </div>
  );
}
