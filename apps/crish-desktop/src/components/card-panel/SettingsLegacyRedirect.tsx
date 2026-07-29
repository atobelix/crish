import React, { useEffect } from 'react';
import { openSettings } from '../../api/storeAccess';

export function SettingsLegacyRedirect() {
  useEffect(() => {
    openSettings();
  }, []);
  return (
    <div className="panel-legacy-redirect" role="status" aria-live="polite">
      <span>正在打开设置…</span>
    </div>
  );
}
