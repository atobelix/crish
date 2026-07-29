import React, { useEffect } from 'react';
import { focusOrOpenPanel } from '../../api/storeAccess';

export function PlanLegacyRedirect({ wsId }: { wsId: string }) {
  useEffect(() => {
    focusOrOpenPanel(wsId, 'overview');
  }, [wsId]);
  return (
    <div className="panel-legacy-redirect" role="status" aria-live="polite">
      <span>已自动跳转到项目总览…</span>
    </div>
  );
}
