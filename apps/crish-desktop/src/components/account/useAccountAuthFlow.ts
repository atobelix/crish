/**
 * 登录弹窗步骤状态机（邮箱 / 验证码 / 密码 / 设置密码）。
 *
 * 与账号中心接口的对应：
 * - 邮箱 →「继续」请求 login 场景验证码 → 验证码步骤 → 确认即登录；
 *   邮箱未注册时服务端拒绝，展示服务端文案并提供「注册新账号」入口；
 * - 「使用密码登录」→ 密码步骤；「忘记密码」/「注册新账号」按稿先发验证码 → 验证码步骤 → 设置密码；
 * - 先码后密码经 authRequestPasswordCode / authSetPasswordWithCode 对接账号中心。
 */
import { useCallback, useRef, useState } from 'react';
import {
  AuthApiError,
  authConfirmEmailCode,
  authRequestEmailCode,
  authRequestPasswordCode,
  authSetPasswordWithCode,
  type EmailCodeScene,
  type PasswordCodeScene,
} from '../../api/authApi';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { authErrorText } from './authErrorText';
import {
  ACCOUNT_RESEND_SECONDS,
  isValidEmail,
  isValidPassword,
} from './accountRules';
import { useResendCountdown } from './useResendCountdown';

export type AuthStep = 'email' | 'code' | 'password' | 'set';

export function useAccountAuthFlow(onSignedIn: () => void) {
  const { t } = useI18n();
  const login = useAuthField((state) => state.login);
  const completeLogin = useAuthField((state) => state.completeLogin);
  const {
    left: resendLeft,
    restart: restartCountdown,
    stop: stopCountdown,
  } = useResendCountdown(ACCOUNT_RESEND_SECONDS);

  const [step, setStep] = useState<AuthStep>('email');
  const [scene, setScene] = useState<EmailCodeScene>('login');
  const [email, setEmailValue] = useState('');
  const [password, setPasswordValue] = useState('');
  const [code, setCodeValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [offerRegister, setOfferRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const go = useCallback((next: AuthStep) => {
    setError(null);
    setOfferRegister(false);
    setStep(next);
  }, []);

  /** 串行执行一次请求：忙碌中忽略重复提交，失败转为界面文案 */
  const run = useCallback(
    async (task: () => Promise<void>, onError?: (err: unknown) => void) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await task();
      } catch (err: unknown) {
        setError(authErrorText(err, t));
        onError?.(err);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [t]
  );

  const sendCode = useCallback(
    async (target: EmailCodeScene) => {
      if (target === 'login') await authRequestEmailCode('login', email.trim());
      else
        await authRequestPasswordCode({ scene: target, email: email.trim() });
      restartCountdown();
    },
    [restartCountdown, email]
  );

  /** 注册 / 找回：先发验证码，成功后进入验证码步骤 */
  const startCodeFirst = (target: PasswordCodeScene) => {
    if (!isValidEmail(email)) return;
    void run(async () => {
      setScene(target);
      setPasswordValue('');
      setCodeValue('');
      await sendCode(target);
      go('code');
    });
  };

  const submitEmail = () => {
    if (!isValidEmail(email)) return;
    void run(
      async () => {
        await sendCode('login');
        setScene('login');
        setCodeValue('');
        go('code');
      },
      (err) => {
        // 账号中心拒绝（多为邮箱未注册）时给出注册入口
        if (err instanceof AuthApiError && err.kind === 'rejected')
          setOfferRegister(true);
      }
    );
  };

  const submitPassword = () => {
    if (!isValidEmail(email) || !password) return;
    void run(async () => {
      await login(email.trim(), password);
      onSignedIn();
    });
  };

  const submitSet = () => {
    if (scene === 'login' || !isValidPassword(password)) return;
    void run(async () => {
      const user = await authSetPasswordWithCode({
        scene,
        email: email.trim(),
        code,
        password,
      });
      await completeLogin(user);
      onSignedIn();
    });
  };

  const submitCode = (full: string) => {
    // 注册 / 找回：验证码随设置密码一并提交
    if (scene !== 'login') {
      setCodeValue(full);
      go('set');
      return;
    }
    void run(
      async () => {
        const user = await authConfirmEmailCode(scene, email.trim(), full);
        await completeLogin(user);
        onSignedIn();
      },
      () => setCodeValue('')
    );
  };

  const resend = () => {
    void run(() => sendCode(scene));
  };

  const startPassword = () => {
    setPasswordValue('');
    go('password');
  };

  const startRegister = () => startCodeFirst('register');

  const startReset = () => startCodeFirst('reset');

  const back = () => {
    if (step === 'set') {
      setCodeValue('');
      go('code');
    } else if (step === 'code' && scene === 'reset') go('password');
    else go('email');
  };

  const reset = useCallback(() => {
    setStep('email');
    setScene('login');
    setEmailValue('');
    setPasswordValue('');
    setCodeValue('');
    setError(null);
    setOfferRegister(false);
    stopCountdown();
  }, [stopCountdown]);

  // 编辑即清除错误
  const setEmail = (value: string) => {
    setEmailValue(value);
    setError(null);
    setOfferRegister(false);
  };
  const setPassword = (value: string) => {
    setPasswordValue(value);
    setError(null);
  };
  const setCode = (value: string) => {
    setCodeValue(value);
    setError(null);
  };

  return {
    step,
    scene,
    email,
    password,
    code,
    error,
    offerRegister,
    busy,
    resendLeft,
    setEmail,
    setPassword,
    setCode,
    submitEmail,
    submitPassword,
    submitSet,
    submitCode,
    resend,
    startPassword,
    startRegister,
    startReset,
    back,
    reset,
  };
}

export type AccountAuthFlow = ReturnType<typeof useAccountAuthFlow>;
