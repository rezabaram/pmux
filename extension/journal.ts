/**
 * pmux — Journal System
 *
 * Append-only JSONL log for decisions, learnings, and progress.
 * Shared across all agents in a session.
 * Recent entries are injected into the system prompt (sliding window).
 *
 * File per session:
 *   journal.jsonl — one JSON object per line (append-only)
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────

export interface JournalEntry {
  timestamp: string; // ISO 8601
  agent: string; // who wrote it
  agentId: string; // agent UUID
  type: "decision" | "learning" | "progress";
  content: string; // the actual entry
  context?: string; // optional context (e.g., task ID, topic)
}

// ─── Constants ───────────────────────────────────────────────

/** Number of recent journal entries injected into the system prompt. */
export const JOURNAL_WINDOW_SIZE = 10;

// ─── Paths ───────────────────────────────────────────────────

const PMUX_DIR = join(homedir(), ".pmux", "sessions");

function journalPath(session: string): string {
  return join(PMUX_DIR, session, "journal.jsonl");
}

// ─── Journal Operations ─────────────────────────────────────

/**
 * Append a journal entry to the session log.
 * Uses appendFileSync — fast, no atomic write needed for append-only.
 */
export function appendEntry(session: string, entry: JournalEntry): void {
  const path = journalPath(session);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Read journal entries from the session log.
 *
 * @param limit - Maximum number of entries to return (from the end). Default: all.
 * @param type - Filter by entry type. Default: all types.
 * @returns Entries in chronological order.
 */
export function readEntries(
  session: string,
  limit?: number,
  type?: JournalEntry["type"]
): JournalEntry[] {
  const path = journalPath(session);
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }

  let entries: JournalEntry[] = lines.map((line) => {
    try {
      return JSON.parse(line) as JournalEntry;
    } catch {
      return null;
    }
  }).filter((e): e is JournalEntry => e !== null);

  if (type) {
    entries = entries.filter((e) => e.type === type);
  }

  if (limit && limit > 0) {
    entries = entries.slice(-limit);
  }

  return entries;
}

/**
 * Get recent journal entries for system prompt injection.
 * Returns the last N entries in chronological order.
 */
export function getRecentEntries(session: string, limit: number = JOURNAL_WINDOW_SIZE): JournalEntry[] {
  return readEntries(session, limit);
}

/**
 * Format a journal entry for display.
 * Returns a single-line string like:
 *   [2026-06-19 14:00] Negin (decision): Use zod for validation
 */
export function formatEntry(entry: JournalEntry): string {
  const date = entry.timestamp.slice(0, 16).replace("T", " ");
  const ctx = entry.context ? ` [${entry.context}]` : "";
  return `[${date}] ${entry.agent} (${entry.type})${ctx}: ${entry.content}`;
}
