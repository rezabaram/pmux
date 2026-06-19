/**
 * pmux — File-Based Messaging
 *
 * Each agent has an inbox directory: ~/.pmux/sessions/<session>/inbox/<uuid>/
 * Messages are individual JSON files, delivered via fs.watch + pi.sendUserMessage().
 * No tmux dependency. No polling.
 */

import {
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────

export interface InboxMessage {
  id: string; // message UUID
  from: string; // sender agent UUID
  fromName: string; // sender display name
  fromRole?: string; // sender role (if any)
  fromSession: string; // sender session
  timestamp: string; // ISO 8601
  message: string; // message content
}

// ─── Paths ───────────────────────────────────────────────────

const PMUX_DIR = join(homedir(), ".pmux", "sessions");

function inboxDir(session: string, agentId: string): string {
  return join(PMUX_DIR, session, "inbox", agentId);
}

// ─── Inbox Operations ────────────────────────────────────────

/** Ensure the inbox directory exists. */
export function ensureInbox(session: string, agentId: string): void {
  mkdirSync(inboxDir(session, agentId), { recursive: true });
}

/**
 * Send a message to an agent's inbox.
 * Uses atomic write (tmp + rename) so watchers never see partial files.
 */
export function sendToInbox(
  session: string,
  targetId: string,
  message: InboxMessage
): void {
  const dir = inboxDir(session, targetId);
  mkdirSync(dir, { recursive: true });

  const base = `${Date.now()}-${message.id}`;
  const tmpFile = join(dir, `${base}.tmp`);
  const jsonFile = join(dir, `${base}.json`);

  writeFileSync(tmpFile, JSON.stringify(message, null, 2), "utf8");
  renameSync(tmpFile, jsonFile);
}

/** Read all pending messages from an inbox, sorted by timestamp. */
export function readPendingMessages(
  session: string,
  agentId: string
): Array<{ msg: InboxMessage; filename: string }> {
  const dir = inboxDir(session, agentId);
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    return files.map((f) => ({
      msg: JSON.parse(readFileSync(join(dir, f), "utf8")) as InboxMessage,
      filename: f,
    }));
  } catch {
    return [];
  }
}

/** Delete a processed message file. */
export function deleteMessage(
  session: string,
  agentId: string,
  filename: string
): void {
  try {
    unlinkSync(join(inboxDir(session, agentId), filename));
  } catch {
    // Already deleted or doesn't exist
  }
}

/**
 * Watch an inbox for new messages.
 * Calls onMessage when a new .json file appears (atomic rename).
 * Returns the FSWatcher (call .close() to stop).
 */
export function watchInbox(
  session: string,
  agentId: string,
  onMessage: (msg: InboxMessage, filename: string) => void
): FSWatcher {
  const dir = inboxDir(session, agentId);
  mkdirSync(dir, { recursive: true });

  return watch(dir, (eventType, filename) => {
    // Only process .json files (not .tmp files being written)
    if (!filename || !filename.endsWith(".json")) return;

    try {
      const content = readFileSync(join(dir, filename), "utf8");
      const msg = JSON.parse(content) as InboxMessage;
      onMessage(msg, filename);
    } catch {
      // File may have been deleted already or still being written
    }
  });
}

/** Generate a unique message ID. */
export function newMessageId(): string {
  return randomUUID();
}
