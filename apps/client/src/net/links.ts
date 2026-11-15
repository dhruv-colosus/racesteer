/**
 * Links that get shown to other devices. In development the display runs on
 * localhost, which a phone cannot reach, so those links point at the LAN
 * HTTPS dev server instead.
 */
export function publicOrigin(): string {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  return local && __LAN_ORIGIN__ ? __LAN_ORIGIN__ : window.location.origin;
}

export const roomLink = (code: string) => `${publicOrigin()}/r/${code}`;
export const padLink = (code: string, token: string) => `${publicOrigin()}/pad/${code}/${token}`;
