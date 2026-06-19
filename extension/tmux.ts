/**
 * pmux — tmux Integration (Optional)
 *
 * Provides tmux detection and visual enhancements.
 * All functions are optional — pmux works without tmux.
 * Communication uses file-based messaging, not tmux send-keys.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ─── Types ───────────────────────────────────────────────────

export interface TmuxInfo {
  session: string; // tmux session name
  pane: string; // full pane target: "session:window.pane"
  windowName: string; // tmux window name (used for team)
}

// ─── Detection ───────────────────────────────────────────────

/** Returns true if running inside tmux. */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Detect current tmux session, pane, and window name.
 * Single tmux call. Returns null if not inside tmux.
 */
export async function detectTmux(): Promise<TmuxInfo | null> {
  if (!isInsideTmux()) return null;

  try {
    const fmt =
      "#{session_name}\t#{session_name}:#{window_index}.#{pane_index}\t#{window_name}";
    const { stdout } = await execAsync(`tmux display-message -p '${fmt}'`);
    const [session, pane, windowName] = stdout.trim().split("\t");

    if (!session || !pane || !windowName) return null;
    return { session, pane, windowName };
  } catch {
    return null;
  }
}

// ─── Visual Enhancements (no-op if not in tmux) ──────────────

/** Set the tmux pane title (visible with pane-border-status). */
export async function setPaneTitle(pane: string, title: string): Promise<void> {
  if (!isInsideTmux()) return;
  try {
    await execAsync(
      `tmux select-pane -t '${pane}' -T '${title.replace(/'/g, "'\\''")}'`
    );
  } catch {
    // Ignore — tmux might not be available
  }
}

/** Set the tmux window name (used for team). */
export async function setWindowName(pane: string, name: string): Promise<void> {
  if (!isInsideTmux()) return;
  try {
    await execAsync(
      `tmux rename-window -t '${pane}' '${name.replace(/'/g, "'\\''")}'`
    );
  } catch {
    // Ignore
  }
}
