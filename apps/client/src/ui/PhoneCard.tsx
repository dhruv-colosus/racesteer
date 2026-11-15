import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { padLink, shareOriginKind } from '../net/links';

interface PhoneCardProps {
  code: string;
  /** Pairing token from the server; null while it is still on its way. */
  token: string | null;
  connected: boolean;
  /** Shown instead of the QR code when the game server cannot be reached. */
  offline?: boolean;
}

/** "Scan this to turn your phone into the wheel" — used in the lobby and in solo practice. */
export function PhoneCard({ code, token, connected, offline = false }: PhoneCardProps) {
  const [qr, setQr] = useState<string | null>(null);
  const link = token ? padLink(code, token) : null;
  const origin = shareOriginKind();

  useEffect(() => {
    let cancelled = false;
    setQr(null);
    if (!link) return;
    QRCode.toDataURL(link, { margin: 1, width: 336, errorCorrectionLevel: 'M' }).then(
      (url) => !cancelled && setQr(url),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [link]);

  if (offline) {
    return (
      <div className="phone">
        <div className="phone-text">
          <p>The game server is not running, so a phone cannot pair right now. The keyboard still works.</p>
        </div>
      </div>
    );
  }

  if (connected) {
    return (
      <div className="phone">
        <div className="phone-text">
          <p>Hold it sideways like a steering wheel. Tilt to steer, right thumb for gas, left thumb for brake.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="phone">
      {qr ? <img src={qr} alt="QR code that opens the controller on your phone" /> : <div className="phone-qr-placeholder" />}
      <div className="phone-text">
        <p>Scan with your phone camera. It becomes your steering wheel: tilt to steer, thumbs for gas and brake.</p>
        {link && <span className="phone-link">{link}</span>}
        {origin === 'lan' && (
          <p className="muted">
            The phone must be on the same Wi-Fi. Every new phone shows a certificate warning the first time — choose
            to proceed (on iPhone: Show Details → visit this website). If it only shows an error with no way through,
            open the link in Safari or Chrome instead of the camera’s preview. Still stuck? Stop the game and run{' '}
            <code>pnpm dev:tunnel</code> — no warning, works on any network.
          </p>
        )}
        {origin === 'tunnel' && <p className="muted">Tunnel link: works from any network, no certificate warning.</p>}
        <p className="muted">No phone? Drive with WASD or the arrow keys.</p>
      </div>
    </div>
  );
}
