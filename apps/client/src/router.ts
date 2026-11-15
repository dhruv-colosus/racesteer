import { useSyncExternalStore } from 'react';
import { isRoomCode, normalizeRoomCode } from '@racing/shared';

/** The whole app is four routes, so the History API is all the router it needs. */
export type Route =
  | { name: 'home' }
  | { name: 'solo' }
  | { name: 'room'; code: string }
  | { name: 'pad'; code: string; token: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'solo') return { name: 'solo' };
  if (parts[0] === 'r' && parts[1]) {
    const code = normalizeRoomCode(parts[1]);
    if (isRoomCode(code)) return { name: 'room', code };
  }
  if (parts[0] === 'pad' && parts[1] && parts[2]) {
    const code = normalizeRoomCode(parts[1]);
    if (isRoomCode(code)) return { name: 'pad', code, token: parts[2] };
  }
  return { name: 'home' };
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
window.addEventListener('popstate', notify);

export function navigate(path: string, options: { replace?: boolean } = {}) {
  if (path === window.location.pathname) return;
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  notify();
}

export function usePathname(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => window.location.pathname,
  );
}
