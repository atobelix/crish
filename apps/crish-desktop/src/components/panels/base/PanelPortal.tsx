import { ReactNode, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

function PanelPortal({ children, zIndex }: { children: ReactNode; zIndex?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  
  return createPortal(
    <div style={{ zIndex: zIndex ?? undefined }} data-portal>
      {children}
    </div>,
    document.body
  );
}

export default PanelPortal;
