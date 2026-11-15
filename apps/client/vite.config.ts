import os from 'node:os';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Two dev servers run from this one config:
 *  - display: http://localhost:5173 — the big screen. localhost is already a secure context.
 *  - LAN:     https://<your-ip>:5174 — what phones open. Motion sensors need HTTPS,
 *             so this one serves a self-signed certificate.
 * Both proxy /colyseus to the game server, so a phone only has to trust one origin.
 */
const lan = process.env.LAN_HTTPS === '1';
const GAME_SERVER = process.env.GAME_SERVER ?? 'http://localhost:2567';
const DISPLAY_PORT = 5173;
const LAN_PORT = 5174;

function lanAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

const ip = lanAddress();

export default defineConfig({
  plugins: [react(), ...(lan ? [basicSsl()] : [])],
  define: {
    // Where other devices on the network can reach this dev build. Empty in production builds.
    __LAN_ORIGIN__: JSON.stringify(process.env.NODE_ENV === 'production' || !ip ? '' : `https://${ip}:${LAN_PORT}`),
  },
  cacheDir: lan ? 'node_modules/.vite-lan' : 'node_modules/.vite',
  server: {
    host: lan ? true : 'localhost',
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
