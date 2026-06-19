/**
 * pmux CLI — Launch and manage multi-agent Pi sessions in tmux
 *
 * This is the full CLI implementation in TypeScript.
 * It runs directly via Node.js 24+ (native TypeScript support).
 *
 * Usage:
 *   pmux                                         Start a session in cwd
 *   pmux [--model MODEL] [--session NAME]        Start with options
 *   pmux start <session> <agent:dir[:role]> ...   Start with explicit agents
 *   pmux start --config <file.json>               Start from config file
 *   pmux stop   <session>                         Stop a session
 *   pmux list   [session]                         Show session info
 *   pmux attach <session>                         Attach to session
 */

import { execSync, type ExecSyncOptions } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { rmSync } from "node:fs";

// ─── Types ───────────────────────────────────────────────────

interface RoleDefinition {
  name: string;
  instructions: string;
}

interface SessionConfig {
  model?: string;
  createdAt?: string;
}

interface AgentInfo {
  name: string;
  session: string;
  role: string;
  roleName?: string;
  cwd: string;
  pane: string;
  pid: number;
  registeredAt: string;
  lastHeartbeat: string;
  status: string;
}

interface ConfigFile {
  session: string;
  model?: string;
  layout?: string;
  roles?: Record<string, { instructions: string }>;
  agents: Record<string, {
    dir: string;
    role?: string;
    model?: string;
  }>;
}

// ─── Paths ───────────────────────────────────────────────────

const PMUX_DIR = join(homedir(), ".pmux", "sessions");

function sessionDir(session: string): string {
  return join(PMUX_DIR, session);
}

// ─── Helpers ─────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function exec(cmd: string, opts?: ExecSyncOptions): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
  } catch {
    return "";
  }
}

function execOrDie(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e: any) {
    die(`command failed: ${cmd}\n${e.stderr || e.message}`);
  }
}

function tmuxHasSession(session: string): boolean {
  try {
    execSync(`tmux has-session -t ${shellEscape(session)}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function deriveSessionName(): string {
  return basename(process.cwd())
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|^$/g, "session");
}

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function writeSessionFiles(
  session: string,
  model: string | undefined,
  roles: Record<string, RoleDefinition> | undefined
): void {
  const dir = sessionDir(session);
  mkdirSync(dir, { recursive: true });

  // config.json
  const config: SessionConfig = { createdAt: new Date().toISOString() };
  if (model) config.model = model;
  writeJsonFile(join(dir, "config.json"), config);

  // roles.json
  writeJsonFile(join(dir, "roles.json"), roles ?? {});
}

// ─── Commands ────────────────────────────────────────────────

function cmdQuick(args: string[]): void {
  let session = "";
  let model = "";

  // Parse options
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--model":
        model = args[++i] ?? die("--model requires a value");
        break;
      case "--session":
        session = args[++i] ?? die("--session requires a value");
        break;
      default:
        die(`unknown option: ${args[i]}. Use 'pmux help'.`);
    }
    i++;
  }

  if (!session) session = deriveSessionName();

  if (tmuxHasSession(session)) {
    console.log(`Session '${session}' already exists. Attaching...`);
    execSync(`tmux attach -t ${shellEscape(session)}`, { stdio: "inherit" });
    process.exit(0);
  }

  console.log(`Starting pmux session '${session}' in ${process.cwd()}...`);

  writeSessionFiles(session, model || undefined, undefined);

  // Create tmux session and start pi
  execSync(`tmux new-session -d -s ${shellEscape(session)} -c ${shellEscape(process.cwd())}`, {
    stdio: "pipe",
  });

  const envParts = [`PMUX_SESSION=${shellEscape(session)}`];
  if (model) envParts.push(`PMUX_MODEL=${shellEscape(model)}`);

  execSync(
    `tmux send-keys -t ${shellEscape(session + ":0.0")} ` +
      `${shellEscape(`export ${envParts.join(" ")}; clear; pi`)} Enter`,
    { stdio: "pipe" }
  );

  console.log(`Session '${session}' is ready.\n`);
  console.log(`  Split a pane:    Ctrl-B %  (or Ctrl-B ")`);
  console.log(`  Start pi:        pi`);
  console.log(`  Register role:   /pmux_register <roleName>\n`);
  console.log(`Attaching now...`);

  execSync(`tmux attach -t ${shellEscape(session)}`, { stdio: "inherit" });
}

function cmdStart(args: string[]): void {
  // Check for --config
  if (args[0] === "--config") {
    cmdStartConfig(args.slice(1));
    return;
  }

  const session = args[0];
  if (!session) die("missing session name. Usage: pmux start <session> <agent:dir[:role]> ...");

  const rest = args.slice(1);

  // Extract --model from remaining args
  let model = "";
  const specs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--model") {
      model = rest[++i] ?? die("--model requires a value");
    } else {
      specs.push(rest[i]!);
    }
  }

  if (specs.length === 0) die("need at least one agent spec.");

  if (tmuxHasSession(session)) {
    die(`tmux session '${session}' already exists. Use 'pmux attach ${session}' or 'pmux stop ${session}'.`);
  }

  // Parse agent specs: name:dir[:role]
  const agents: Array<{ name: string; dir: string; role: string }> = [];
  const seenNames = new Set<string>();

  for (const spec of specs) {
    const parts = spec.split(":");
    const name = parts[0]!;
    const dir = parts[1];
    const role = parts.slice(2).join(":"); // role may contain colons

    if (!name) die(`empty agent name in spec: ${spec}`);
    if (!dir) die(`empty directory in spec: ${spec}`);

    const absDir = resolve(dir);
    if (!existsSync(absDir)) die(`directory does not exist: ${dir}`);
    if (seenNames.has(name)) die(`duplicate agent name: ${name}`);

    seenNames.add(name);
    agents.push({ name, dir: absDir, role });
  }

  console.log(`Starting pmux session '${session}' with ${agents.length} agent(s)...`);

  writeSessionFiles(session, model || undefined, undefined);

  // Create tmux session
  execSync(
    `tmux new-session -d -s ${shellEscape(session)} -c ${shellEscape(agents[0]!.dir)}`,
    { stdio: "pipe" }
  );

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;

    if (i > 0) {
      execSync(
        `tmux split-window -t ${shellEscape(session)} -c ${shellEscape(agent.dir)} -h`,
        { stdio: "pipe" }
      );
      exec(`tmux select-layout -t ${shellEscape(session)} tiled`);
    }

    const envParts = [
      `PMUX_SESSION=${shellEscape(session)}`,
      `PMUX_AGENT=${shellEscape(agent.name)}`,
    ];
    if (model) envParts.push(`PMUX_MODEL=${shellEscape(model)}`);
    if (agent.role) envParts.push(`PMUX_ROLE_NAME=${shellEscape(agent.role)}`);

    const pane = `${session}:0.${i}`;
    execSync(
      `tmux send-keys -t ${shellEscape(pane)} ` +
        `${shellEscape(`export ${envParts.join(" ")}; clear; pi`)} Enter`,
      { stdio: "pipe" }
    );

    const roleLabel = agent.role ? ` (role: ${agent.role})` : "";
    console.log(`  ✓ ${agent.name} → ${agent.dir}${roleLabel}`);
  }

  exec(`tmux select-layout -t ${shellEscape(session)} tiled`);

  console.log(`\nSession '${session}' is ready.`);
  console.log(`Attach with: pmux attach ${session}`);
}

function cmdStartConfig(args: string[]): void {
  const configFile = args[0];
  if (!configFile) die("missing config file. Usage: pmux start --config <file.json>");
  if (!existsSync(configFile)) die(`config file not found: ${configFile}`);

  let cfg: ConfigFile;
  try {
    cfg = JSON.parse(readFileSync(configFile, "utf8")) as ConfigFile;
  } catch (e: any) {
    die(`failed to parse config file: ${e.message}`);
  }

  if (!cfg.session) die("missing 'session' in config file");
  if (!cfg.agents || Object.keys(cfg.agents).length === 0) die("no agents defined in config file");

  const session = cfg.session;
  const model = cfg.model ?? "";
  const layout = cfg.layout ?? "tiled";

  // Validate agent roles reference defined roles
  if (cfg.roles) {
    for (const [aname, aconf] of Object.entries(cfg.agents)) {
      if (aconf.role && !cfg.roles[aconf.role]) {
        die(`agent '${aname}' references undefined role: '${aconf.role}'`);
      }
    }
  }

  if (tmuxHasSession(session)) {
    die(`tmux session '${session}' already exists. Use 'pmux stop ${session}' first.`);
  }

  console.log(`Starting pmux session '${session}' from config: ${configFile}`);

  // Build roles map
  const roles: Record<string, RoleDefinition> = {};
  if (cfg.roles) {
    for (const [name, def] of Object.entries(cfg.roles)) {
      roles[name] = { name, instructions: def.instructions };
    }
  }

  writeSessionFiles(session, model || undefined, Object.keys(roles).length > 0 ? roles : undefined);

  // Resolve agent dirs relative to config file
  const configDir = dirname(resolve(configFile));
  const agentEntries = Object.entries(cfg.agents);

  // Create tmux session with first agent
  const firstDir = resolve(configDir, agentEntries[0]![1].dir);
  execSync(`tmux new-session -d -s ${shellEscape(session)} -c ${shellEscape(firstDir)}`, {
    stdio: "pipe",
  });

  for (let i = 0; i < agentEntries.length; i++) {
    const [aname, aconf] = agentEntries[i]!;
    const absDir = resolve(configDir, aconf.dir);
    const agentModel = aconf.model ?? model;

    if (i > 0) {
      execSync(
        `tmux split-window -t ${shellEscape(session)} -c ${shellEscape(absDir)} -h`,
        { stdio: "pipe" }
      );
      exec(`tmux select-layout -t ${shellEscape(session)} ${shellEscape(layout)}`);
    }

    const envParts = [
      `PMUX_SESSION=${shellEscape(session)}`,
      `PMUX_AGENT=${shellEscape(aname)}`,
    ];
    if (agentModel) envParts.push(`PMUX_MODEL=${shellEscape(agentModel)}`);
    if (aconf.role) envParts.push(`PMUX_ROLE_NAME=${shellEscape(aconf.role)}`);

    const pane = `${session}:0.${i}`;
    execSync(
      `tmux send-keys -t ${shellEscape(pane)} ` +
        `${shellEscape(`export ${envParts.join(" ")}; clear; pi`)} Enter`,
      { stdio: "pipe" }
    );

    const roleLabel = aconf.role ? ` (role: ${aconf.role})` : "";
    const modelLabel = aconf.model ? ` (model: ${aconf.model})` : "";
    console.log(`  ✓ ${aname} → ${absDir}${roleLabel}${modelLabel}`);
  }

  exec(`tmux select-layout -t ${shellEscape(session)} ${shellEscape(layout)}`);

  console.log(`\nSession '${session}' is ready.`);
  console.log(`Attach with: pmux attach ${session}`);
}

function cmdStop(args: string[]): void {
  const session = args[0];
  if (!session) die("missing session name. Usage: pmux stop <session>");

  if (!tmuxHasSession(session)) {
    console.log(`No tmux session '${session}' found.`);
    const dir = sessionDir(session);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    return;
  }

  console.log(`Stopping pmux session '${session}'...`);

  // Get all panes
  const panes = exec(
    `tmux list-panes -t ${shellEscape(session)} -F '#{session_name}:#{window_index}.#{pane_index}'`
  );

  // Send Ctrl-C to each pane
  for (const pane of panes.split("\n").filter(Boolean)) {
    exec(`tmux send-keys -t ${shellEscape(pane)} C-c`);
  }

  // Wait for graceful shutdown
  execSync("sleep 1", { stdio: "pipe" });

  for (const pane of panes.split("\n").filter(Boolean)) {
    exec(`tmux send-keys -t ${shellEscape(pane)} C-c`);
  }

  execSync("sleep 0.5", { stdio: "pipe" });

  // Kill session
  exec(`tmux kill-session -t ${shellEscape(session)}`);

  // Clean up registry
  const dir = sessionDir(session);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  console.log(`Session '${session}' stopped.`);
}

function cmdList(args: string[]): void {
  let session = args[0];

  // If no session specified, list all sessions
  if (!session) {
    if (!existsSync(PMUX_DIR)) {
      console.log("No pmux sessions found.");
      return;
    }
    const dirs = readdirSync(PMUX_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    if (dirs.length === 0) {
      console.log("No pmux sessions found.");
      return;
    }

    console.log("pmux sessions:\n");
    for (const name of dirs) {
      const active = tmuxHasSession(name) ? "  (active)" : "  (stopped)";
      console.log(`  ${name}${active}`);
    }
    console.log(`\nUse 'pmux list <session>' for details.`);
    return;
  }

  const dir = sessionDir(session);
  console.log(`Session: ${session}`);
  console.log(`Active:  ${tmuxHasSession(session) ? "yes" : "no"}`);
  console.log("");

  // Show config
  const config = readJsonFile<SessionConfig>(join(dir, "config.json"), {});
  console.log(`  Model: ${config.model ?? "(default)"}`);

  // Show roles
  const roles = readJsonFile<Record<string, RoleDefinition>>(join(dir, "roles.json"), {});
  const roleNames = Object.keys(roles);
  if (roleNames.length > 0) {
    console.log(`  Roles: ${roleNames.length} defined`);
    for (const [name, role] of Object.entries(roles)) {
      const preview =
        role.instructions.length > 80
          ? role.instructions.slice(0, 80) + "..."
          : role.instructions;
      // Collapse newlines for preview
      console.log(`    - ${name}: ${preview.replace(/\n/g, " ")}`);
    }
  } else {
    console.log("  Roles: none defined");
  }

  console.log("");

  // Show agents
  const agents = readJsonFile<Record<string, AgentInfo>>(join(dir, "agents.json"), {});
  const agentEntries = Object.values(agents);

  if (agentEntries.length === 0) {
    console.log("  Agents: (none registered)");
    return;
  }

  console.log("  Agents:");
  const now = Date.now();
  for (const a of agentEntries) {
    const age = now - new Date(a.lastHeartbeat).getTime();
    const stale = age > 120_000 ? " (stale)" : "";
    const icon = a.status === "working" ? "●" : "○";
    const roleLabel = a.roleName ? `role:${a.roleName}` : a.role;
    console.log(`    ${icon} ${a.name.padEnd(15)} [${a.status.padEnd(7)}]${stale}  ${roleLabel}`);
    console.log(`      cwd:  ${a.cwd}`);
    console.log(`      pane: ${a.pane}`);
  }
}

function cmdAttach(args: string[]): void {
  const session = args[0];
  if (!session) die("missing session name. Usage: pmux attach <session>");

  if (!tmuxHasSession(session)) {
    die(`no tmux session '${session}' found. Start one with: pmux`);
  }

  execSync(`tmux attach -t ${shellEscape(session)}`, { stdio: "inherit" });
}

function cmdHelp(): void {
  console.log(`Usage: pmux [command] [options]

Quick start (no arguments):
  pmux                           Start a session in the current directory
  pmux --model <model>           Start with a default model
  pmux --session <name>          Start with a custom session name

Commands:
  start  <session> <name:dir[:role]> ...   Start with explicit agents
  start  --config <file.json>              Start from a JSON config file
  stop   <session>                          Stop all agents and kill session
  list   [session]                          Show session(s) info
  attach <session>                          Attach to the tmux session

Agent spec format:
  name:directory[:role]

  name       Unique agent name
  directory  Working directory for the agent
  role       Optional role name (must be defined in roles.json)

Config file (JSON):
  {
    "session": "myproject",
    "model": "claude-sonnet-4",
    "roles": {
      "frontend": { "instructions": "You are a React developer..." },
      "backend":  { "instructions": "You are an API developer..." }
    },
    "agents": {
      "frontend": { "dir": "./frontend", "role": "frontend" },
      "backend":  { "dir": "./backend",  "role": "backend" }
    }
  }

Examples:
  pmux
  pmux --model claude-sonnet-4
  pmux start myproject frontend:./fe:frontend backend:./be:backend
  pmux start --config pmux.json
  pmux list
  pmux stop myproject`);
}

// ─── Main ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cmd = args[0] ?? "";

switch (cmd) {
  case "start":
    cmdStart(args.slice(1));
    break;
  case "stop":
    cmdStop(args.slice(1));
    break;
  case "list":
    cmdList(args.slice(1));
    break;
  case "attach":
    cmdAttach(args.slice(1));
    break;
  case "help":
  case "--help":
  case "-h":
    cmdHelp();
    break;
  case "":
    cmdQuick([]);
    break;
  default:
    if (cmd.startsWith("--")) {
      // Options for quick mode
      cmdQuick(args);
    } else {
      die(`unknown command: ${cmd}. Use 'pmux help'.`);
    }
    break;
}
