import os from 'node:os';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Two dev servers run from this one config:
 *  - display: http://localhost:5173 — the big screen, also open on the LAN at
 *             http://<your-ip>:5173 so a TV or another laptop can join in.
 *  - LAN:     https://<your-ip>:5174 — what phones open. Motion sensors need HTTPS,
 *             so this one serves a self-signed certificate.
 * Both proxy /colyseus to the game server, so a phone only has to trust one origin.
 *
 * `pnpm dev:tunnel` sets PUBLIC_ORIGIN to a public HTTPS tunnel that forwards
 * to the display server. Phones are then sent there instead of the LAN address:
 * it has a real certificate and works even when a VPN hides this machine.
 */
const lan = process.env.LAN_HTTPS === '1';
const GAME_SERVER = process.env.GAME_SERVER ?? 'http://localhost:2567';
const DISPLAY_PORT = 5173;
const LAN_PORT = 5174;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN?.replace(/\/$/, '') || '';

/**
 * The address other devices on the Wi-Fi can reach this machine on.
 * Wi-Fi and Ethernet come first: a VPN adds utun interfaces with addresses of
 * their own, and those are useless to a phone sitting on the same Wi-Fi.
 */
function lanAddress(): string | null {
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list ?? [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => ({ name, address: address.address })),
  );
  const physical = addresses.find(({ name }) => /^en\d+$/.test(name));
  return (physical ?? addresses[0])?.address ?? null;
}

const ip = lanAddress();

export default defineConfig({
  plugins: [react(), ...(lan ? [basicSsl()] : [])],
  define: {
    // Where other devices can reach this dev build. Empty in production builds.
    __SHARE_ORIGIN__: JSON.stringify(
      process.env.NODE_ENV === 'production' ? '' : PUBLIC_ORIGIN || (ip ? `https://${ip}:${LAN_PORT}` : ''),
    ),
    // The display server straight over the Wi-Fi. Laptops on the same network use this
    // instead of the tunnel: a tunnel sends every packet out to Cloudflare and back.
    __LAN_ORIGIN__: JSON.stringify(process.env.NODE_ENV === 'production' || !ip ? '' : `http://${ip}:${DISPLAY_PORT}`),
  },
  cacheDir: lan ? 'node_modules/.vite-lan' : 'node_modules/.vite',
  server: {
    // Listen on every interface, so the display is open on the LAN too (http://<your-ip>:5173):
    // other laptops in the room need it, tunnel or not. The tunnel connects over IPv4
    // (127.0.0.1), so in tunnel mode listen on every IPv4 address rather than IPv6 only.
    host: lan ? true : PUBLIC_ORIGIN ? '0.0.0.0' : true,
    allowedHosts: PUBLIC_ORIGIN ? [new URL(PUBLIC_ORIGIN).hostname] : [],
    port: lan ? LAN_PORT : DISPLAY_PORT,
    strictPort: true,
    proxy: {
      '/colyseus': {
        target: GAME_SERVER,
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/colyseus/, ''),
      },
    },
  },
});
