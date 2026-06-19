/**
 * pmux — tmux Detection and Communication Helpers
 *
 * Detects the current tmux pane and provides send-keys functionality
 * for inter-agent messaging.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// --- Types ---

export interface TmuxPaneInfo {
  session: string; // tmux session name
  pane: string; // full pane target: "session:window.pane"
}

// --- Detection ---

/**
 * Detect the current tmux pane.
 * Returns null if not running inside tmux.
 */
export async function detectTmuxPane(): Promise<TmuxPaneInfo | null> {
  // $TMUX is set by tmux for processes inside a session
  if (!process.env.TMUX) {
    return null;
  }

  try {
    const { stdout: sessionRaw } = await execAsync(
      "tmux display-message -p '#{session_name}'"
    );
    const { stdout: paneRaw } = await execAsync(
      "tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'"
    );

    const session = sessionRaw.trim();
    const pane = paneRaw.trim();

    if (!session || !pane) return null;

    return { session, pane };
  } catch {
    return null;
  }
}

// --- Communication ---

/**
 * Send a text message to a tmux pane via send-keys.
 *
 * Uses the -l (literal) flag to prevent tmux from interpreting
 * special key names. Sends Enter separately to submit the message.
 */
export async function sendKeys(pane: string, text: string): Promise<void> {
  // Escape the text for shell and send as literal
  const escaped = shellEscape(text);
  const paneEscaped = shellEscape(pane);

  // Send the text literally (no key name interpretation)
  await execAsync(`tmux send-keys -t ${paneEscaped} -l ${escaped}`);

  // Send Enter to submit
  await execAsync(`tmux send-keys -t ${paneEscaped} Enter`);
}

// --- Utilities ---

/**
 * Shell-escape a string using single quotes.
 * Handles embedded single quotes by breaking out and escaping.
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
