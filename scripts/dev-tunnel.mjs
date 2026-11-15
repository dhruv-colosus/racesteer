#!/usr/bin/env node
/**
 * `pnpm dev`, but phones are sent to a public HTTPS tunnel instead of the LAN
 * address. Use it when a phone cannot open the LAN link (a VPN or firewall on
 * this computer, guest Wi-Fi, mobile data) or refuses the self-signed
 * certificate.
 *
 * It opens a Cloudflare quick tunnel to the display server and passes its URL
 * to the dev servers as PUBLIC_ORIGIN. While it runs, anyone who has that
 * random URL can reach this dev build; it stops when you press Ctrl+C.
 * Everything sent through the tunnel goes out to a Cloudflare data centre and
 * back (60+ ms even from this machine), so laptops on the same Wi-Fi should use
 * the direct LAN link printed below instead. The lobby offers it too.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

/** This machine's Wi-Fi/Ethernet address (same rule as vite.config.ts). */
function lanAddress() {
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address })),
  );
  return (addresses.find(({ name }) => /^en\d+$/.test(name)) ?? addresses[0])?.address ?? null;
}

const TARGET = 'http://127.0.0.1:5173';
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', TARGET], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let dev = null;

const stop = (code = 0) => {
  tunnel.kill();
  dev?.kill();
  process.exit(code);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

tunnel.on('error', (error) => {
  if (error.code === 'ENOENT') {
    console.error('cloudflared is not installed. Install it with:  brew install cloudflared');
  } else {
    console.error('Could not start the tunnel:', error.message);
  }
  process.exit(1);
});
tunnel.on('exit', (code) => {
  if (!dev) {
    console.error(`The tunnel closed before it gave a URL (exit ${code}).`);
    process.exit(1);
  }
  console.error('\nThe tunnel closed. Stopping the dev servers.');
  stop(1);
});

const onOutput = (chunk) => {
  if (dev) return;
  const match = String(chunk).match(URL_PATTERN);
  if (!match) return;
  const origin = match[0];
  const ip = lanAddress();
  console.log(
    `\n  Phones will be sent to:   ${origin}` +
      `\n  Open the display at:      http://localhost:5173   (not the tunnel URL — that adds 60+ ms)` +
      (ip ? `\n  Laptops on this Wi-Fi:    http://${ip}:5173   (direct, lowest ping)` : '') +
      `\n  Laptops anywhere else:    ${origin}\n`,
  );
  dev = spawn('pnpm', ['dev'], { stdio: 'inherit', env: { ...process.env, PUBLIC_ORIGIN: origin } });
  dev.on('exit', (code) => stop(code ?? 0));
};
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);

console.log('Opening tunnel…');
