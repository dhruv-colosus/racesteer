/// <reference types="vite/client" />

/**
 * Dev only: the origin other devices should use to reach this build — the LAN
 * HTTPS server, or a tunnel URL. Empty in production builds.
 */
declare const __SHARE_ORIGIN__: string;

/** Dev only: the display server's plain-http address on this machine's Wi-Fi, e.g. http://192.168.1.20:5173. */
declare const __LAN_ORIGIN__: string;
