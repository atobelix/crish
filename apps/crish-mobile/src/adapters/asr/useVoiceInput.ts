// 语音输入 React 接线：把纯状态机（domain/asr/voiceInputMachine）、
// 管线服务（voiceInputService）与模型管理器（modelManager）组装成
// Composer 可直接消费的按压手势 API。
//
// 流程：
// - 按下：先查模型——未就绪弹下载门（不录音）；就绪则请求权限并开录，
//   权限被拒/引擎失败一律 Toast 诚实告知并回落打字（01 文档 W-D 口径）；
// - 按住滑动：位移驱动 recording ⇄ cancelling；
// - 松手：recording → 收尾（等最后一条 final）后非空文本回填并提交，
//   空结果 Toast「没有听清」；cancelling → 丢弃，不打扰用户；
// - 启动耗时（首次建引擎）期间已松手 → 就绪后立即按松手结局收尾。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AsrResultEvent } from '@/domain/asr/simulatedStreamingPipeline';
import {
  applyAsrResult,
  EMPTY_VOICE_TEXT,
  voiceDisplayText,
  voiceFinalText,
  voicePhaseForTranslation,
  voiceReleaseOutcome,
  type VoicePhase,
  type VoiceTextState,
} from '@/domain/asr/voiceInputMachine';
import {
  ASR_MODEL_TOTAL_BYTES,
  asrModelManager,
  type AsrModelState,
} from './modelManager';
import { voiceInputService } from './voiceInputService';

export interface UseVoiceInputOptions {
  /** 最终文本提交（松开自动发送，01 文档 W-D） */
  onSubmitText: (text: string) => void;
  /** 最终文本回填输入框（与提交同刻，先回填保证可见） */
  onFillText: (text: string) => void;
  /** 诚实提示通道（由屏幕接 Toast） */
  notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
}

export interface VoiceInputApi {
  phase: VoicePhase;
  /** 启动中（首次建引擎等）：浮层以「准备中」呈现 */
  starting: boolean;
  displayText: string;
  level: number;
  /** 模型下载门状态（visible 时渲染 Dialog） */
  gateState: AsrModelState | null;
  gateVisible: boolean;
  /** 模型总字节数（下载门文案用，由适配层注入，UI 不直依赖模型清单） */
  modelTotalBytes: number;
  pressStart: () => void;
  pressMove: (translationY: number) => void;
  pressEnd: () => void;
  confirmDownload: () => void;
  dismissGate: () => void;
}

export function useVoiceInput(options: UseVoiceInputOptions): VoiceInputApi {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [starting, setStarting] = useState(false);
  const [textState, setTextState] = useState<VoiceTextState>(EMPTY_VOICE_TEXT);
  const [level, setLevel] = useState(0);
  const [gateState, setGateState] = useState<AsrModelState | null>(null);
  const [gateVisible, setGateVisible] = useState(false);

  const phaseRef = useRef<VoicePhase>('idle');
  const textRef = useRef<VoiceTextState>(EMPTY_VOICE_TEXT);
  const pressWantedRef = useRef(false);
  const startingRef = useRef(false);
  const finishingRef = useRef(false);

  const setPhaseBoth = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const setTextBoth = useCallback((next: VoiceTextState) => {
    textRef.current = next;
    setTextState(next);
  }, []);

  const handleResult = useCallback(
    (event: AsrResultEvent) => {
      setTextBoth(applyAsrResult(textRef.current, event));
    },
    [setTextBoth]
  );

  const finishSession = useCallback(
    async (outcome: 'submit' | 'discard') => {
      if (finishingRef.current) return;
      finishingRef.current = true;
      if (outcome === 'discard') {
        voiceInputService.cancel();
        setTextBoth(EMPTY_VOICE_TEXT);
        setLevel(0);
        setPhaseBoth('idle');
        finishingRef.current = false;
        return;
      }
      setPhaseBoth('finishing');
      await voiceInputService.stop();
      const text = voiceFinalText(textRef.current);
      setTextBoth(EMPTY_VOICE_TEXT);
      setLevel(0);
      setPhaseBoth('idle');
      finishingRef.current = false;
      if (text.length > 0) {
        optionsRef.current.onFillText(text);
        optionsRef.current.onSubmitText(text);
      } else {
        optionsRef.current.notify('没有听清，请重试', 'info');
      }
    },
    [setPhaseBoth, setTextBoth]
  );

  const beginSession = useCallback(async () => {
    const modelState = await asrModelManager().check();
    if (modelState.kind !== 'ready') {
      // 模型未就绪：弹下载门，本次按压不录音
      pressWantedRef.current = false;
      startingRef.current = false;
      setStarting(false);
      setGateState({ kind: 'missing' });
      setGateVisible(true);
      return;
    }
    const outcome = await voiceInputService.start(modelState.paths, {
      onResult: handleResult,
      onLevel: (next) => setLevel(next),
      onError: (message) => optionsRef.current.notify(message, 'error'),
    });
    startingRef.current = false;
    setStarting(false);
    if (outcome !== 'started') {
      pressWantedRef.current = false;
      if (outcome === 'permission-denied') {
        optionsRef.current.notify(
          '麦克风权限被拒绝，请在系统设置中开启，或继续打字输入',
          'error'
        );
      } else {
        optionsRef.current.notify('语音输入暂时不可用，请打字输入', 'error');
      }
      return;
    }
    if (!pressWantedRef.current) {
      // 启动期间用户已松手：立即按提交结局收尾（多为空结果→提示）
      void finishSession('submit');
      return;
    }
    setPhaseBoth('recording');
  }, [finishSession, handleResult, setPhaseBoth]);

  const pressStart = useCallback(() => {
    if (phaseRef.current !== 'idle' || startingRef.current) return;
    if (!voiceInputService.isAvailable()) {
      optionsRef.current.notify('当前设备不支持离线语音输入', 'error');
      return;
    }
    pressWantedRef.current = true;
    startingRef.current = true;
    setStarting(true);
    setTextBoth(EMPTY_VOICE_TEXT);
    void beginSession();
  }, [beginSession, setTextBoth]);

  const pressMove = useCallback(
    (translationY: number) => {
      const current = phaseRef.current;
      if (current !== 'recording' && current !== 'cancelling') return;
      const next = voicePhaseForTranslation(current, translationY);
      if (next !== current) setPhaseBoth(next);
    },
    [setPhaseBoth]
  );

  const pressEnd = useCallback(() => {
    pressWantedRef.current = false;
    if (startingRef.current) return; // beginSession 完成时按松手结局收尾
    const outcome = voiceReleaseOutcome(phaseRef.current);
    if (outcome === 'submit') void finishSession('submit');
    else if (outcome === 'discard') void finishSession('discard');
  }, [finishSession]);

  const confirmDownload = useCallback(() => {
    void asrModelManager().ensureReady((state) => {
      setGateState(state);
      if (state.kind === 'ready') {
        setGateVisible(false);
        setGateState(null);
        optionsRef.current.notify(
          '语音模型下载完成，可长按麦克风说话',
          'success'
        );
      }
    });
  }, []);

  const dismissGate = useCallback(() => {
    // 下载中关闭仅收起弹窗，后台下载继续（管理器在途去重保证不重复拉取）
    setGateVisible(false);
  }, []);

  // 卸载时若仍在录音，直接取消释放采集（引擎保留复用）
  useEffect(
    () => () => {
      if (
        phaseRef.current === 'recording' ||
        phaseRef.current === 'cancelling'
      ) {
        voiceInputService.cancel();
      }
    },
    []
  );

  return {
    phase,
    starting,
    displayText: voiceDisplayText(textState),
    level,
    gateState,
    gateVisible,
    modelTotalBytes: ASR_MODEL_TOTAL_BYTES,
    pressStart,
    pressMove,
    pressEnd,
    confirmDownload,
    dismissGate,
  };
}

export default useVoiceInput;
