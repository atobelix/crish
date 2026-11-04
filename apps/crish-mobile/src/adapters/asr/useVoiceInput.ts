// 语音输入 React 接线：把纯状态机（domain/asr/voiceInputMachine）、
// 管线服务（voiceInputService）与模型管理器（modelManager）组装成
// Composer 可直接消费的按压手势 API。
//
// 流程：
// - 按下：先查模型——未就绪弹下载门（不录音）；就绪则请求权限并开录；
// - 硬错误（权限被拒/引擎/采集失败/识别出错）：落常驻错误态（VoiceErrorBar
//   呈现），按根因带恢复动作（去设置/重新初始化/重试），绝不只弹一条
//   Toast 就断头（2026-11-02 用户投诉：报错后没有任何能重试的地方）；
//   瞬时提示（没听清、下载完成）仍走 Toast；
// - 按住滑动：位移驱动 recording ⇄ cancelling；
// - 松手：recording → 收尾（等最后一条 final）后非空文本回填并提交，
//   空结果 Toast「没有听清」；cancelling → 丢弃，不打扰用户；
// - 启动耗时（首次建引擎）期间已松手 → 就绪后立即按松手结局收尾。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import type { AsrResultEvent } from '@/domain/asr/simulatedStreamingPipeline';
import {
  applyAsrResult,
  EMPTY_VOICE_TEXT,
  voiceDisplayText,
  voiceFinalText,
  voicePhaseForTranslation,
  voicePhaseForTranslation2D,
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

/** 语音硬错误的恢复通道（呈现面据此给动作钮，文案在 VoiceErrorBar） */
export type VoiceRecovery = 'retry-init' | 'retry-capture' | 'open-settings';

export interface VoiceErrorState {
  message: string;
  /** null = 无恢复动作（设备根本不支持），错误条仅可关闭 */
  recovery: VoiceRecovery | null;
}

export interface VoiceInputApi {
  phase: VoicePhase;
  /** 启动中（首次建引擎等）：浮层以「准备中」呈现 */
  starting: boolean;
  displayText: string;
  level: number;
  /** 常驻硬错误（带恢复动作）；null = 无错误 */
  error: VoiceErrorState | null;
  /** 执行错误对应的恢复动作（重新初始化/去设置/收起待重试） */
  recover: () => void;
  /** 关闭错误呈现 */
  dismissError: () => void;
  /** 模型下载门状态（visible 时渲染 Dialog） */
  gateState: AsrModelState | null;
  gateVisible: boolean;
  /** 模型总字节数（下载门文案用，由适配层注入，UI 不直依赖模型清单） */
  modelTotalBytes: number;
  pressStart: () => void;
  /** 手势位移更新：支持纯 Y（1D 上滑）或 X+Y（2D 左右扇区与中央走廊） */
  pressMove: (translationXOrY: number, translationY?: number) => void;
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
  const [error, setError] = useState<VoiceErrorState | null>(null);

  const phaseRef = useRef<VoicePhase>('idle');
  const textRef = useRef<VoiceTextState>(EMPTY_VOICE_TEXT);
  const pressWantedRef = useRef(false);
  const startingRef = useRef(false);
  const finishingRef = useRef(false);

  const setPhaseBoth = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const errorRef = useRef<VoiceErrorState | null>(null);
  const setErrorBoth = useCallback((next: VoiceErrorState | null) => {
    errorRef.current = next;
    setError(next);
  }, []);
  /** 待落定的引擎重初始化（recover 触发）：下一次 beginSession 先等它 */
  const reinitRef = useRef<Promise<void> | null>(null);

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
    async (outcome: 'submit' | 'discard' | 'edit') => {
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
        if (outcome === 'submit') {
          optionsRef.current.onSubmitText(text);
        }
      } else {
        optionsRef.current.notify('没有听清，请重试', 'info');
      }
    },
    [setPhaseBoth, setTextBoth]
  );

  const beginSession = useCallback(async () => {
    // 上一次 recover 触发的引擎重初始化先落定，保证本次用新引擎启动
    if (reinitRef.current) {
      await reinitRef.current;
      reinitRef.current = null;
    }
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
      // 识别管道中途出错：引擎状态不可信 → 常驻错误 + 重新初始化通道
      onError: (message) => setErrorBoth({ message, recovery: 'retry-init' }),
    });
    startingRef.current = false;
    setStarting(false);
    if (outcome !== 'started') {
      pressWantedRef.current = false;
      // 硬错误按根因落常驻错误态（错误条带恢复动作，不再 Toast 断头）
      if (outcome === 'permission-denied') {
        setErrorBoth({
          message: '麦克风权限被拒绝',
          recovery: 'open-settings',
        });
      } else if (outcome === 'engine-failed') {
        setErrorBoth({ message: '语音引擎启动失败', recovery: 'retry-init' });
      } else if (outcome === 'capture-failed') {
        setErrorBoth({ message: '麦克风启动失败', recovery: 'retry-capture' });
      } else {
        setErrorBoth({ message: '当前设备不支持离线语音输入', recovery: null });
      }
      return;
    }
    if (!pressWantedRef.current) {
      // 启动期间用户已松手：立即按提交结局收尾（多为空结果→提示）
      void finishSession('submit');
      return;
    }
    setPhaseBoth('recording');
  }, [finishSession, handleResult, setErrorBoth, setPhaseBoth]);

  const pressStart = useCallback(() => {
    if (phaseRef.current !== 'idle' || startingRef.current) return;
    if (!voiceInputService.isAvailable()) {
      setErrorBoth({ message: '当前设备不支持离线语音输入', recovery: null });
      return;
    }
    setErrorBoth(null);
    pressWantedRef.current = true;
    startingRef.current = true;
    setStarting(true);
    setTextBoth(EMPTY_VOICE_TEXT);
    void beginSession();
  }, [beginSession, setErrorBoth, setTextBoth]);

  const recover = useCallback(() => {
    const current = errorRef.current;
    if (!current) return;
    if (current.recovery === 'open-settings') {
      // 权限在系统侧被拒：唯一真实恢复通道是系统设置页
      void Linking.openSettings();
      return;
    }
    if (current.recovery === 'retry-init') {
      // 引擎重初始化：释放引擎，下次按压重建；beginSession 先等释放落定
      reinitRef.current = voiceInputService.release();
    }
    // retry-capture 无引擎状态可清：收起错误，下一次按压即全新尝试
    setErrorBoth(null);
  }, [setErrorBoth]);

  const dismissError = useCallback(() => {
    setErrorBoth(null);
  }, [setErrorBoth]);

  const pressMove = useCallback(
    (translationXOrY: number, translationY?: number) => {
      const current = phaseRef.current;
      if (
        current !== 'recording' &&
        current !== 'cancelling' &&
        current !== 'editing'
      ) {
        return;
      }
      let next: VoicePhase;
      if (typeof translationY === 'number') {
        next = voicePhaseForTranslation2D(
          current,
          translationXOrY,
          translationY
        );
      } else {
        next = voicePhaseForTranslation(current, translationXOrY);
      }
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
    else if (outcome === 'edit') void finishSession('edit');
  }, [finishSession]);

  const confirmDownload = useCallback(() => {
    void asrModelManager().ensureReady((state) => {
      setGateState(state);
      if (state.kind === 'ready') {
        setGateVisible(false);
        setGateState(null);
        optionsRef.current.notify(
          '语音模型就绪，现在长按输入框即可说话',
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
    error,
    recover,
    dismissError,
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
