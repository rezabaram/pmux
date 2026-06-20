/**
 * pmux — Agent Registry, Roles, and Session Config
 *
 * Agents are keyed by UUID. Names are for human-friendly addressing.
 * Agents persist across restarts with online/offline status.
 *
 * Files per session:
 *   agents.json  — agent registry (keyed by UUID)
 *   roles.json   — role definitions (name + instructions)
 *   config.json  — session config (default model, etc.)
 */

import { readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────

export interface AgentInfo {
  id: string; // UUID — primary key, stable across restarts
  name: string; // human-friendly display name
  session: string; // pmux session name
  role: string; // human-readable role description
  roleName?: string; // references a RoleDefinition name
  workspace?: string; // git worktree path
  cwd: string;
  pane?: string; // tmux pane target (optional — only if tmux)
  pid: number;
  status: "online" | "offline";
  registeredAt: string; // ISO 8601
  lastHeartbeat: string; // ISO 8601
}

export type Registry = Record<string, AgentInfo>; // keyed by UUID

export interface RoleDefinition {
  name: string;
  description?: string; // short one-liner for display
  instructions: string;
}

export type RolesMap = Record<string, RoleDefinition>;

export interface SessionConfig {
  model?: string;
  mainRepo?: string; // path to the main git repo
  createdAt?: string;
}

export type AgentAddress = string;

// ─── Paths ───────────────────────────────────────────────────

const PMUX_DIR = join(homedir(), ".pmux", "sessions");

function registryPath(session: string): string {
  return join(PMUX_DIR, session, "agents.json");
}

function rolesPath(session: string): string {
  return join(PMUX_DIR, session, "roles.json");
}

function configPath(session: string): string {
  return join(PMUX_DIR, session, "config.json");
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

// ─── Agent Registry ──────────────────────────────────────────

export async function readRegistry(session: string): Promise<Registry> {
  return readJson<Registry>(registryPath(session), {});
}

async function writeRegistry(session: string, data: Registry): Promise<void> {
  await atomicWriteJson(registryPath(session), data);
}

/** Generate a new agent UUID. */
export function newAgentId(): string {
  return randomBytes(4).toString("hex");
}

/** Register or update an agent in the registry. */
export async function registerAgent(session: string, agent: AgentInfo): Promise<void> {
  const registry = await readRegistry(session);
  registry[agent.id] = agent;
  await writeRegistry(session, registry);
}

/** Remove an agent entirely from the registry. */
export async function removeAgent(session: string, id: string): Promise<void> {
  const registry = await readRegistry(session);
  delete registry[id];
  await writeRegistry(session, registry);
}

/** Update specific fields of an agent. */
export async function updateAgent(
  session: string,
  id: string,
  updates: Partial<AgentInfo>
): Promise<void> {
  const registry = await readRegistry(session);
  const agent = registry[id];
  if (!agent) return;
  Object.assign(agent, updates);
  await writeRegistry(session, registry);
}

/** Mark an agent as online with current pid/pane. */
export async function goOnline(
  session: string,
  id: string,
  pid: number,
  pane?: string
): Promise<void> {
  await updateAgent(session, id, {
    status: "online",
    pid,
    pane,
    lastHeartbeat: new Date().toISOString(),
  });
}

/** Mark an agent as offline. */
export async function goOffline(session: string, id: string): Promise<void> {
  await updateAgent(session, id, { status: "offline" });
}

/** Update heartbeat timestamp and optionally status. */
export async function updateHeartbeat(
  session: string,
  id: string,
  status?: "online" | "offline"
): Promise<void> {
  const updates: Partial<AgentInfo> = { lastHeartbeat: new Date().toISOString() };
  if (status) updates.status = status;
  await updateAgent(session, id, updates);
}

// ─── Lookups ─────────────────────────────────────────────────

/** Find an agent by name within a session. */
export async function findByName(
  session: string,
  name: string
): Promise<AgentInfo | null> {
  const registry = await readRegistry(session);
  return Object.values(registry).find((a) => a.name === name) ?? null;
}

/** Find an agent by UUID within a session. */
export async function findById(
  session: string,
  id: string
): Promise<AgentInfo | null> {
  const registry = await readRegistry(session);
  return registry[id] ?? null;
}

/** Get all online agents in a session. */
export async function getOnlineAgents(session: string): Promise<AgentInfo[]> {
  const registry = await readRegistry(session);
  return Object.values(registry).filter((a) => a.status === "online");
}

/** Get all offline agents in a session. */
export async function getOfflineAgents(session: string): Promise<AgentInfo[]> {
  const registry = await readRegistry(session);
  return Object.values(registry).filter((a) => a.status === "offline");
}

/** Get all agents across all sessions. */
export async function readAllRegistries(): Promise<AgentInfo[]> {
  const allAgents: AgentInfo[] = [];
  try {
    const sessionDirs = await readdir(PMUX_DIR, { withFileTypes: true });
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const registry = await readRegistry(entry.name);
      for (const agent of Object.values(registry)) {
        agent.session = agent.session || entry.name;
        allAgents.push(agent);
      }
    }
  } catch {
    // ~/.pmux/sessions/ may not exist yet
  }
  return allAgents;
}

/**
 * Resolve an agent address: "name" (same session) or "session/name" (cross-session).
 * Returns null if not found.
 */
export async function resolveAgent(
  address: string,
  defaultSession: string
): Promise<AgentInfo | null> {
  const { session, name } = parseAddress(address, defaultSession);
  return findByName(session, name);
}

// ─── Roles ───────────────────────────────────────────────────

export async function readRoles(session: string): Promise<RolesMap> {
  return readJson<RolesMap>(rolesPath(session), {});
}

async function writeRoles(session: string, roles: RolesMap): Promise<void> {
  await atomicWriteJson(rolesPath(session), roles);
}

export async function getRole(session: string, name: string): Promise<RoleDefinition | null> {
  const roles = await readRoles(session);
  return roles[name] ?? null;
}

export async function addRole(session: string, role: RoleDefinition): Promise<void> {
  const roles = await readRoles(session);
  roles[role.name] = role;
  await writeRoles(session, roles);
}

export async function removeRole(session: string, name: string): Promise<boolean> {
  const roles = await readRoles(session);
  if (!roles[name]) return false;
  delete roles[name];
  await writeRoles(session, roles);
  return true;
}

// ─── Session Config ──────────────────────────────────────────

export async function readSessionConfig(session: string): Promise<SessionConfig> {
  return readJson<SessionConfig>(configPath(session), {});
}

export async function writeSessionConfig(
  session: string,
  config: SessionConfig
): Promise<void> {
  await atomicWriteJson(configPath(session), config);
}

// ─── Addressing ──────────────────────────────────────────────

export function formatAddress(session: string, name: string): string {
  return `${session}/${name}`;
}

export function parseAddress(
  address: string,
  defaultSession: string
): { session: string; name: string } {
  const i = address.indexOf("/");
  return i === -1
    ? { session: defaultSession, name: address }
    : { session: address.slice(0, i), name: address.slice(i + 1) };
}
