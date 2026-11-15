import { Component, type ErrorInfo, type ReactNode } from 'react';
import { markCrashing } from '../net/session';

const RELOADED_AT = 'tiltrush.crashReloadAt';
/** A second crash this soon after an automatic reload means reloading is not helping. */
const LOOP_WINDOW_MS = 30_000;

function recentlyReloaded(): boolean {
  try {
    return Date.now() - Number(sessionStorage.getItem(RELOADED_AT) ?? 0) < LOOP_WINDOW_MS;
  } catch {
    return true; // cannot tell — do not risk a reload loop
  }
}

/**
 * Last line of defence for a crash in the UI. Seats, pairings and race
 * position all survive a reload, so the quickest way back into the game is
 * simply to reload — once. If it crashes again straight away, stop and say so.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; reloading: boolean }> {
  state = { failed: false, reloading: false };

  static getDerivedStateFromError() {
    // Before the broken screens unmount: they must keep their seats for the reload, not leave.
    markCrashing();
    return { failed: true, reloading: !recentlyReloaded() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[app] crashed', error, info.componentStack);
    if (!this.state.reloading) return;
    try {
      sessionStorage.setItem(RELOADED_AT, String(Date.now()));
    } catch {
      /* handled by recentlyReloaded() returning true next time */
    }
    window.location.reload();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.state.reloading) return <div className="center-screen caps">Recovering…</div>;
    return (
      <div className="center-screen">
        <div className="card">
          <h2 className="caps">Something broke</h2>
          <p className="muted">The game hit an error it could not recover from on its own.</p>
          <div className="card-actions">
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button className="btn" onClick={() => window.location.assign('/')}>
              Back to menu
            </button>
          </div>
        </div>
      </div>
    );
  }
}
