import { useState, useEffect } from 'react';
import { isProductShellFast } from '../createSsrGlobals';
import { useLayoutStore } from '../store/layoutStore';

export function useEngineBootstrap(): boolean {
  const [engineReady, setEngineReady] = useState(false);
  const productShell = isProductShellFast();

  useEffect(() => {
    import('../api/daemonClient').then(({ getDesktopDaemonClient }) => {
      const client = getDesktopDaemonClient();
      if (client.hasEverConnected() || client.isConnected()) {
        setEngineReady(true);
      }
    });
  }, []);

  useEffect(() => {
    const initEngine = async () => {
      const { bootstrapDesktopBackend } = await import('../api/daemonClient');
      const client = bootstrapDesktopBackend();
      if (client.isConnected() || client.hasEverConnected()) {
        setEngineReady(true);
      }
      const unsub = client.onState((s) => {
        if (s === 'connected' || client.hasEverConnected()) {
          setEngineReady(true);
        }
      });
      const { ensureDaemonConnected } = await import('../api/daemonChatBridge');
      void ensureDaemonConnected().then((res) => {
        if (res.ok || client.hasEverConnected()) setEngineReady(true);
        else if (!productShell) {
          console.warn('[crish-desktop] engine offline after boot wait (keep-alive continues)');
        }
        if (res.ok) {
          void import('../api/providerProfiles').then(({ syncActiveProfileToEngine }) => {
            void syncActiveProfileToEngine();
          });
          void import('../api/sessionDaemonSync').then(({ syncSessionsFromDaemon }) => {
            void syncSessionsFromDaemon(
              () => useLayoutStore.getState().sessions,
              (sessions) => useLayoutStore.getState().setSessions(sessions)
            );
          });
        }
      });
      const gateTimer = window.setTimeout(() => { setEngineReady(true); }, productShell ? 12_000 : 0);
      return () => {
        unsub();
        window.clearTimeout(gateTimer);
      };
    };
    const cleanupPromise = initEngine();
    return () => { cleanupPromise.then((cleanup) => cleanup?.()); };
  }, [productShell]);

  return engineReady;
}
