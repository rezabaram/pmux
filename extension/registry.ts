/**
 * pmux — Shared Agent Registry, Roles, and Session Config
 *
 * Manages agent registration, role definitions, and session configuration
 * in shared JSON files under ~/.pmux/sessions/<session>/.
 *
 * Files per session:
 *   agents.json  — live agent registry
 *   roles.json   — role definitions (name + instructions)
 *   config.json  — session config (default model, etc.)
 *
 * Uses atomic writes (temp file + rename) to prevent corruption.
 * Supports both same-session and cross-session agent discovery.
 */

import { readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  session: string; // pmux/tmux session this agent belongs to
  team?: string; // team name (= tmux window name)
  role: string; // human-readable role description
  roleName?: string; // references a RoleDefinition name (if registered via role)
  cwd: string;
  pane: string; // tmux target: "session:window.pane"
  pid: number;
  registeredAt: string; // ISO 8601
  lastHeartbeat: string; // ISO 8601
  status: "idle" | "working" | "busy";
}

export type Registry = Record<string, AgentInfo>;

export interface RoleDefinition {
  name: string;
  instructions: string;
}

export type RolesMap = Record<string, RoleDefinition>;

export interface SessionConfig {
  model?: string; // default model for all agents (e.g. "claude-sonnet-4")
  createdAt?: string;
}

/** Fully qualified agent address: "session/agent". */
export type AgentAddress = string;

// ─── Paths ───────────────────────────────────────────────────

const PMUX_DIR = join(homedir(), ".pmux", "sessions");

function sessionDir(session: string): string {
  return join(PMUX_DIR, session);
}

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

export async function register(session: string, agent: AgentInfo): Promise<void> {
  const registry = await readRegistry(session);
  registry[agent.name] = agent;
  await writeRegistry(session, registry);
}

export async function deregister(session: string, name: string): Promise<void> {
  const registry = await readRegistry(session);
  delete registry[name];
  await writeRegistry(session, registry);
}

export async function updateAgent(
  session: string,
  name: string,
  updates: Partial<Pick<AgentInfo, "role" | "roleName" | "status" | "lastHeartbeat">>
): Promise<void> {
  const registry = await readRegistry(session);
  const agent = registry[name];
  if (!agent) return;
  Object.assign(agent, updates);
  await writeRegistry(session, registry);
}

export async function updateHeartbeat(
  session: string,
  name: string,
  status?: AgentInfo["status"]
): Promise<void> {
  const updates: Partial<AgentInfo> = { lastHeartbeat: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  await updateAgent(session, name, updates);
}

/** Read ALL registries across every session. */
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

export function filterStaleAgents(
  agents: AgentInfo[] | Registry,
  maxAgeMs: number = 120_000
): AgentInfo[] {
  const list = Array.isArray(agents) ? agents : Object.values(agents);
  const now = Date.now();
  return list.filter((a) => now - new Date(a.lastHeartbeat).getTime() < maxAgeMs);
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

export async function resolveAgent(
  address: string,
  defaultSession: string,
  maxAgeMs: number = 120_000
): Promise<AgentInfo | null> {
  const { session, name } = parseAddress(address, defaultSession);
  const registry = await readRegistry(session);
  const agent = registry[name];
  if (!agent) return null;
  agent.session = agent.session || session;
  if (Date.now() - new Date(agent.lastHeartbeat).getTime() >= maxAgeMs) return null;
  return agent;
}
