import { useCallback, useEffect, useRef, useState } from 'react';
import { Msg, decodePadInput, sanitizeName, type DriveInput } from '@racing/shared';
import { createRoom, loadName, type GameRoom } from './client';
import { CloseCode } from '@colyseus/sdk';
import { forgetToken, isCrashing, loadSession, rejoin, saveSession } from './session';

export interface PracticePhone {
  /** Room code of the hidden practice room; empty until it exists. */
  code: string;
  token: string | null;
  connected: boolean;
  /** The game server cannot be reached right now, so no phone can pair. Clears by itself when it comes back. */
  offline: boolean;
  haptic(ms: number): void;
}

/** Storage slot for the practice room, so a reload returns to the same one and the phone stays paired. */
const SLOT = 'practice';

/**
 * Lets a phone drive in solo practice. Solo needs no server to race, but a
 * phone can only reach the display through one, so this opens a hidden
 * one-seat room purely to pair the phone and relay its input.
 *
 * The room is kept alive through reloads, dropped connections and server
 * restarts: it is reclaimed or recreated under the same code and pairing
 * token, so the phone finds its way back without rescanning.
 */
export function usePracticePhone(onInput: (input: DriveInput) => void): PracticePhone {
  const [state, setState] = useState({ code: '', token: null as string | null, connected: false, offline: false });
  const room = useRef<GameRoom | null>(null);
  const handler = useRef(onInput);
  handler.current = onInput;

  useEffect(() => {
    let cancelled = false;
    const name = sanitizeName(loadName());

    const bind = (joined: GameRoom) => {
      room.current = joined;
      saveSession(SLOT, { code: joined.roomId, token: joined.reconnectionToken, practice: true, name });
      setState((s) => ({ ...s, code: joined.roomId, offline: false }));
      joined.onMessage(Msg.PadToken, (message: { token: string }) => {
        saveSession(SLOT, { code: joined.roomId, padToken: message.token });
        setState((s) => ({ ...s, token: message.token }));
      });
      joined.onMessage(Msg.PadInput, (message: unknown) => {
        const input = decodePadInput(message);
        if (input) handler.current(input);
      });
      joined.onStateChange((roomState) => {
        const connected = roomState.players?.get(joined.sessionId)?.pad === true;
        setState((s) => (s.connected === connected ? s : { ...s, connected }));
      });
      joined.onReconnect(() => saveSession(SLOT, { code: joined.roomId, token: joined.reconnectionToken }));
      joined.onLeave((closeCode) => {
        if (cancelled || room.current !== joined) return;
        if (closeCode === CloseCode.FAILED_TO_RECONNECT) forgetToken(joined.reconnectionToken);
        room.current = null;
        setState((s) => ({ ...s, connected: false }));
        void open();
      });
      joined.send(Msg.PadToken);
    };

    /** Gets the practice room: the saved one if there is one, else a new one. Never gives up while the screen is open. */
    const open = async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          const joined = loadSession(SLOT)
            ? await rejoin(() => loadSession(SLOT), { giveUpAfterMs: 0, cancelled: () => cancelled })
            : await createRoom({ role: 'player', name, practice: true });
          if (cancelled) void joined.leave().catch(() => {});
          else bind(joined);
          return;
        } catch {
          if (cancelled) return;
          // Server down or unreachable: say so, keep driving on the keyboard, and keep trying quietly.
          if (attempt >= 1) setState((s) => ({ ...s, offline: true }));
          await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * 2 ** attempt)));
        }
      }
    };
    void open();

    return () => {
      cancelled = true;
      const active = room.current;
      room.current = null;
      // A crash-reload keeps the room so the phone stays paired; leaving the screen closes it.
      if (!isCrashing()) void active?.leave().catch(() => {});
    };
  }, []);

  const haptic = useCallback((ms: number) => room.current?.send(Msg.Haptic, { ms }), []);
  return { ...state, haptic };
}
