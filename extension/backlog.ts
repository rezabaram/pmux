/**
 * pmux — Task Backlog
 *
 * Lightweight ordered work queue for multi-agent teams.
 * Array order = priority (first item = highest priority).
 * Auto-incrementing IDs: TASK-01, TASK-02, etc.
 *
 * File per session:
 *   backlog.json — Task[] (ordered array)
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────

export interface Task {
  id: string; // "TASK-01" auto-incrementing
  title: string;
  description?: string;
  status: "todo" | "assigned" | "in-progress" | "done" | "blocked";
  team?: string;
  assignee?: string; // agent display name
  assigneeId?: string; // agent UUID
  files?: string[]; // related files (auto-reserve on pick)
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string; // completion notes
  blockedReason?: string;
}

export type Backlog = Task[];

// ─── Paths ───────────────────────────────────────────────────

const PMUX_DIR = join(homedir(), ".pmux", "sessions");

function backlogPath(session: string): string {
  return join(PMUX_DIR, session, "backlog.json");
}

// ─── Atomic I/O ──────────────────────────────────────────────

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + "." + randomBytes(4).toString("hex") + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ─── Backlog Operations ─────────────────────────────────────

/** Read the full task backlog for a session. */
export async function readBacklog(session: string): Promise<Backlog> {
  return readJson<Backlog>(backlogPath(session), []);
}

/** Write the full task backlog for a session (atomic). */
export async function writeBacklog(session: string, tasks: Backlog): Promise<void> {
  await atomicWriteJson(backlogPath(session), tasks);
}

/**
 * Generate the next task ID based on existing tasks.
 * Scans for the highest TASK-XX number and increments.
 */
export function nextTaskId(tasks: Task[]): string {
  let maxNum = 0;
  for (const task of tasks) {
    const match = task.id.match(/^TASK-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `TASK-${String(maxNum + 1).padStart(2, "0")}`;
}

/**
 * Add a new task to the backlog.
 * Appends by default, prepends if urgent.
 */
export async function addTask(
  session: string,
  taskData: Omit<Task, "id">,
  urgent?: boolean
): Promise<Task> {
  const tasks = await readBacklog(session);
  const id = nextTaskId(tasks);
  const task: Task = { id, ...taskData };

  if (urgent) {
    tasks.unshift(task);
  } else {
    tasks.push(task);
  }

  await writeBacklog(session, tasks);
  return task;
}

/** Find a task by ID. */
export async function getTask(session: string, id: string): Promise<Task | null> {
  const tasks = await readBacklog(session);
  return tasks.find((t) => t.id === id) ?? null;
}

/**
 * Update a task by ID with partial fields.
 * Automatically sets updatedAt.
 */
export async function updateTask(
  session: string,
  id: string,
  updates: Partial<Task>
): Promise<Task | null> {
  const tasks = await readBacklog(session);
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;

  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  await writeBacklog(session, tasks);
  return task;
}
