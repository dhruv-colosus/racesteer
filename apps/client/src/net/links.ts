/**
 * Links that get shown to other devices. A phone needs a secure context for the
 * motion sensors, so it is always sent to an https origin when there is one:
 * the LAN server, or a public tunnel when started with `pnpm dev:tunnel`.
 * The display may itself be open on plain http (on the LAN, at http://<your-ip>:5173),
 * and a link to that page would not be able to read the gyroscope.
 */
export function publicOrigin(): string {
  if (window.location.protocol === 'https:') return window.location.origin;
  return __SHARE_ORIGIN__ || window.location.origin;
}

const isIpOrigin = (origin: string) => /^https?:\/\/\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(origin);

/** What kind of address phones are being sent to, so the UI can give the right advice. */
export function shareOriginKind(): 'lan' | 'tunnel' | 'same' {
  const origin = publicOrigin();
  if (origin === window.location.origin) return 'same';
  return isIpOrigin(origin) ? 'lan' : 'tunnel';
}

export const roomLink = (code: string) => `${publicOrigin()}/r/${code}`;
export const padLink = (code: string, token: string) => `${publicOrigin()}/pad/${code}/${token}`;

/** Started with `pnpm dev:tunnel`: invites point at a public tunnel URL. */
const tunnelActive = () => Boolean(__SHARE_ORIGIN__) && !isIpOrigin(__SHARE_ORIGIN__);

/** This page was itself opened through the tunnel, so every message goes out to Cloudflare and back. */
export const onTunnel = () => tunnelActive() && window.location.origin === __SHARE_ORIGIN__;

/**
 * The room on the display server straight over the Wi-Fi, for laptops on the
 * same network as the host. Only offered while a tunnel is up — without one,
 * invites are LAN links already. Plain http is fine here: a display does not
 * read motion sensors. Null when there is no LAN address to offer.
 */
export function lanRoomLink(code: string): string | null {
  if (!tunnelActive() || !__LAN_ORIGIN__ || __LAN_ORIGIN__ === window.location.origin) return null;
  return `${__LAN_ORIGIN__}/r/${code}`;
}
