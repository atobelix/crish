import { useState } from 'preact/hooks';
import type { PendingAskQuestion } from '../core/app-state';
import { IconCheck, IconSpinner } from './icons';

// 主战场内嵌的"严肃问询卡"：不弹窗、不抢占底部输入框。
// props 驱动；由消息流在收到 ask-requested 时挂载，答复经 onAnswer 走 workbench_answer_question。
export default function AskCard({
  question,
  pending,
  onAnswer,
  onCancel,
}: {
  question: PendingAskQuestion;
  pending?: boolean;
  onAnswer: (questionId: string, value: string | string[]) => void;
  onCancel?: (questionId: string) => void;
}) {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const canSubmitText = text.trim().length > 0 || question.required !== true;
  const canSubmitMulti = selected.length > 0 || question.required !== true;

  const toggle = (value: string) => {
    setSelected((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  return (
    <div class="repl-ask-card">
      <div class="repl-ask-card-header">
        <span class="repl-ask-card-badge">需要你的确认</span>
      </div>
      <div class="repl-ask-card-prompt">{question.prompt}</div>

      {question.kind === 'single' && (
        <div class="repl-ask-card-options">
          {(question.options ?? []).map((opt) => (
            <button
              key={opt.value}
              class="repl-deck-btn btn-modify repl-ask-option"
              disabled={pending}
              onClick={() => onAnswer(question.questionId, opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {question.kind === 'multi' && (
        <>
          <div class="repl-ask-card-options">
            {(question.options ?? []).map((opt) => {
              const on = selected.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  class={`repl-deck-btn ${on ? 'btn-approve' : 'btn-modify'} repl-ask-option`}
                  disabled={pending}
                  onClick={() => toggle(opt.value)}
                >
                  {on ? <IconCheck /> : null} {opt.label}
                </button>
              );
            })}
          </div>
          <div class="repl-ask-card-actions">
            <button
              class="repl-deck-btn btn-approve"
              disabled={pending || !canSubmitMulti}
              onClick={() => onAnswer(question.questionId, selected)}
            >
              {pending ? <IconSpinner /> : '提交'}
            </button>
          </div>
        </>
      )}

      {question.kind === 'text' && (
        <div class="repl-ask-card-text">
          <textarea
            class="repl-ask-card-input"
            placeholder="输入你的回答…"
            value={text}
            rows={2}
            disabled={pending}
            onInput={(e: any) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canSubmitText) {
                e.preventDefault();
                onAnswer(question.questionId, text.trim());
              }
            }}
          />
          <div class="repl-ask-card-actions">
            {onCancel && (
              <button class="repl-deck-btn btn-modify" disabled={pending} onClick={() => onCancel(question.questionId)}>
                跳过
              </button>
            )}
            <button
              class="repl-deck-btn btn-approve"
              disabled={pending || !canSubmitText}
              onClick={() => onAnswer(question.questionId, text.trim())}
            >
              {pending ? <IconSpinner /> : '提交'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
