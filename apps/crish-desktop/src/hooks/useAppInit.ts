import { useEffect } from 'react';
import { bootstrapStores } from '../store/bootstrapStores';
import { bootstrapServices } from '../bootstrap-services';

export function useAppInit(): () => void {
  useEffect(() => {
    import('../store/layoutStore').then(({ initLayoutStorePersistence }) => initLayoutStorePersistence());
  }, []);

  useEffect(() => {
    const cleanup = bootstrapServices();
    return () => { cleanup(); };
  }, []);

  useEffect(() => {
    const cleanup = bootstrapStores();
    return () => cleanup();
  }, []);

  return () => {};
}
