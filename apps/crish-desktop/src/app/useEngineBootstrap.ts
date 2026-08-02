/**
 * useEngineBootstrap —— 引擎初始化唯一 hook（T06.8 归一后）。
 *
 * C3.1 transport 语义：
 * - 启动门闩 =「核心已初始化」（transport.isReady / onStatus(connected)）。
 * - 不再 bootstrapDesktopBackend（WS keep-alive / sidecar 重启已删）。
 * - ensureDaemonConnected（daemonChatBridge）内部即 transport.waitUntilConnected。
 * - 就绪后做一次会话列表合并（syncSessionsFromDaemon，list_sessions 走 transport）。
 */
import { useState, useEffect } from 'react';
import { isProductShellFast } from '../createSsrGlobals';
import { getCompositionRoot } from './compositionRoot';

export function useEngineBootstrap(): boolean {
  const [engineReady, setEngineReady] = useState(false);
  const productShell = isProductShellFast();

  useEffect(() => {
    // 早探：transport 已就绪则立即放行（启动门闩不阻塞渲染）
    import('../api/transport').then(({ getTransport }) => {
      const transport = getTransport();
      if (transport.isReady()) {
        setEngineReady(true);
      }
    });
  }, []);

  useEffect(() => {
    const initEngine = async () => {
      const { getTransport } = await import('../api/transport');
      const transport = getTransport();
      if (transport.isReady()) {
        setEngineReady(true);
      }
      const unsub = transport.onStatus((s) => {
        if (s === 'connected') {
          setEngineReady(true);
        }
      });
      const { ensureDaemonConnected } = await import('../api/daemonChatBridge');
      void ensureDaemonConnected().then((res) => {
        if (res.ok) setEngineReady(true);
        else if (!productShell) {
          console.warn('[crish-desktop] engine offline after boot wait');
        }
        if (res.ok) {
          void import('../api/sessionDaemonSync').then(({ syncSessionsFromDaemon }) => {
            const layout = getCompositionRoot().layout;
            void syncSessionsFromDaemon(
              () => layout.getSessions(),
              (sessions) => layout.setSessions(sessions)
            );
          });
        }
      });
      const gateTimer = window.setTimeout(
        () => {
          setEngineReady(true);
        },
        productShell ? 12_000 : 0
      );
      return () => {
        unsub();
        window.clearTimeout(gateTimer);
      };
    };
    const cleanupPromise = initEngine();
    return () => {
      cleanupPromise.then((cleanup) => cleanup?.());
    };
  }, [productShell]);

  return engineReady;
}
