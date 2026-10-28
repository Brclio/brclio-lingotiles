import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccountClient } from './client';

export default function useAccount() {
  const [client] = useState(() => new AccountClient());
  const account = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => {
    void client.initialize();
    const retry = () => { void client.refreshSession(); };
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    return () => { window.removeEventListener('online', retry); window.removeEventListener('focus', retry); };
  }, [client]);
  return { ...account, client };
}
