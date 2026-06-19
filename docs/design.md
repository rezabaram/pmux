# pmux - Pi Multi-Agent Coordination via tmux

## Overview

**pmux** is a lightweight multi-agent system for Pi that uses tmux as the communication backbone. Multiple Pi agents run in separate tmux panes, share a registry of who's online, and talk to each other by typing messages into each other's terminals via `tmux send-keys`.

No servers, no WebSockets, no daemons - just tmux, a shared JSON file, and a Pi extension.

---

## Architecture

```
┌─────────────────────────────────── tmux session: "myproject" ──────────────────────────────────┐
│                                                                                                │
│  ┌─── pane 0.0 ──────────────┐  ┌─── pane 0.1 ──────────────┐  ┌─── pane 0.2 ──────────────┐ │
│  │  pi (frontend agent)      │  │  pi (backend agent)        │  │  pi (devops agent)         │ │
│  │  cwd: ~/proj/frontend     │  │  cwd: ~/proj/backend       │  │  cwd: ~/proj/infra         │ │
│  │                           │  │                            │  │                            │ │
│  │  pmux extension loaded    │  │  pmux extension loaded     │  │  pmux extension loaded     │ │
│  │  tools: pmux_list,        │  │  tools: pmux_list,         │  │  tools: pmux_list,         │ │
│  │         pmux_send,        │  │         pmux_send,         │  │         pmux_send,         │ │
│  │         pmux_broadcast    │  │         pmux_broadcast     │  │         pmux_broadcast     │ │
│  └───────────────────────────┘  └────────────────────────────┘  └────────────────────────────┘ │
│                                                                                                │
│         ▲    │                           ▲    │                          ▲    │                 │
│         │    ▼                           │    ▼                          │    ▼                 │
│     ┌──────────────────────────────────────────────────────────────────────────────┐            │
│     │                    ~/.pmux/sessions/myproject/agents.json                    │            │
│     │  { "frontend": { pane: "myproject:0.0", cwd: "...", ... },                  │            │
│     │    "backend":  { pane: "myproject:0.1", cwd: "...", ... },                  │            │
│     │    "devops":   { pane: "myproject:0.2", cwd: "...", ... } }                 │            │
│     └──────────────────────────────────────────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Flow**: Agent A calls `pmux_send("backend", "add a /health endpoint")` →
extension reads registry → finds backend's pane target → runs
`tmux send-keys -t myproject:0.1 '[pmux:myproject/frontend] add a /health endpoint' Enter` →
message appears as user input in backend's Pi terminal.

**Cross-session**: Agent A calls `pmux_send("infra/devops", "deploy staging")` →
extension reads `~/.pmux/sessions/infra/agents.json` → finds devops's pane target → runs
`tmux send-keys -t infra:0.0 '[pmux:myproject/frontend] deploy staging' Enter` →
message appears in devops's terminal in a completely different tmux session.

---

## Components

### 1. Shared Registry (`~/.pmux/sessions/<session>/agents.json`)

A simple JSON file that all agents read and write. Atomic writes (write to temp + rename) prevent corruption.

```jsonc
{
  "frontend": {
    "name": "frontend",
    "session": "myproject",             // pmux session name
    "role": "Frontend React developer",
    "cwd": "/home/reza/project/frontend",
    "pane": "myproject:0.0",             // tmux target for send-keys
    "pid": 12345,                         // pi process PID
    "registeredAt": "2026-06-19T10:00:00Z",
    "lastHeartbeat": "2026-06-19T10:05:32Z",
    "status": "idle"                      // idle | working | busy
  },
  "backend": {
    "name": "backend",
    "session": "myproject",
    "role": "Backend Node.js API developer",
    "cwd": "/home/reza/project/backend",
    "pane": "myproject:0.1",
    "pid": 12346,
    "registeredAt": "2026-06-19T10:00:01Z",
    "lastHeartbeat": "2026-06-19T10:05:30Z",
    "status": "working"
  }
}
```

### 2. Pi Extension (`~/.pi/agent/extensions/pmux/`)

The core. Auto-discovers the tmux environment and provides tools for inter-agent communication.

```
~/.pi/agent/extensions/pmux/
├── index.ts          # Extension entry point
├── registry.ts       # Registry read/write with atomic operations
├── tmux.ts           # tmux detection and send-keys helpers
└── package.json      # Metadata
```

### 3. Launcher Script (`pmux`)

A bash CLI tool that creates the tmux session, splits panes, sets environment variables, and starts Pi in each pane.

```
~/.local/bin/pmux     # Or wherever you keep scripts
```

---

## Extension Design

### Environment Variables (set by launcher)

| Variable | Purpose | Example |
|----------|---------|---------|
| `PMUX_SESSION` | tmux session name (= registry namespace) | `myproject` |
| `PMUX_AGENT` | Agent name (unique within session) | `frontend` |
| `PMUX_ROLE` | Agent role description | `Frontend React developer` |

If not set, the extension auto-detects from tmux (session name) and falls back to the working directory basename for the agent name.

### Lifecycle

```
pi starts
  └─► session_start
        ├─► detect tmux pane (tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}')
        ├─► read env vars (PMUX_SESSION, PMUX_AGENT, PMUX_ROLE)
        ├─► register in ~/.pmux/sessions/<session>/agents.json
        ├─► start heartbeat interval (every 30s)
        └─► set status widget showing online agents

pi running
  ├─► agent_start → update status to "working"
  ├─► agent_end   → update status to "idle"
  └─► tools available: pmux_list, pmux_send, pmux_broadcast

pi exits
  └─► session_shutdown
        ├─► deregister from agents.json
        └─► clear heartbeat interval
```

### Custom Tools

#### `pmux_list` - List online agents

```typescript
pi.registerTool({
  name: "pmux_list",
  label: "List Agents",
  description: "List online pmux agents. Set allSessions=true for cross-session discovery.",
  promptSnippet: "List online pmux agents (supports cross-session discovery)",
  parameters: Type.Object({
    allSessions: Type.Optional(Type.Boolean({ description: "Include agents from all sessions" })),
  }),
  async execute(_id, params) {
    const agents = params.allSessions
      ? filterStaleAgents(await readAllRegistries())
      : filterStaleAgents(await readRegistry(mySession));
    // Group by session, show full session/name addresses
    const lines = agents.map(a =>
      `- ${a.session}/${a.name} (${a.status}): ${a.role} [cwd: ${a.cwd}]`
    );
    return {
      content: [{ type: "text", text: lines.join("\n") || "No agents online" }],
      details: { agents },
    };
  },
});
```

#### `pmux_send` - Send message to another agent

```typescript
pi.registerTool({
  name: "pmux_send",
  label: "Send to Agent",
  description: "Send a message to another agent. Use 'name' for same-session or 'session/name' for cross-session.",
  promptSnippet: "Send a message to a pmux agent by name or session/name address",
  promptGuidelines: [
    "Use pmux_list first to see which agents are available before using pmux_send.",
    "When using pmux_send, be specific about what you need from the other agent.",
    'For cross-session agents, use the full address in pmux_send: "session/name".',
  ],
  parameters: Type.Object({
    to: Type.String({ description: '"name" for same session, or "session/name" for cross-session' }),
    message: Type.String({ description: "Message or instruction to send" }),
  }),
  async execute(_id, params) {
    // resolveAgent handles both "name" and "session/name" addressing
    const target = await resolveAgent(params.to, mySession, STALE_THRESHOLD_MS);
    if (!target) {
      throw new Error(`Agent "${params.to}" not found. Use pmux_list to see available agents.`);
    }

    // Format message with full sender address: [pmux:session/name]
    const formatted = `[pmux:${mySession}/${myName}] ${params.message}`;
    await sendKeys(target.pane, formatted);

    const targetAddr = `${target.session}/${target.name}`;
    return {
      content: [{ type: "text", text: `Message sent to ${targetAddr} (${target.role})` }],
      details: { to: targetAddr, toSession: target.session, toName: target.name, pane: target.pane },
    };
  },
});
```

#### `pmux_broadcast` - Send to all agents

```typescript
pi.registerTool({
  name: "pmux_broadcast",
  label: "Broadcast",
  description: "Broadcast to online agents. Set allSessions=true for cross-session.",
  promptSnippet: "Broadcast a message to online pmux agents (same session or all sessions)",
  parameters: Type.Object({
    message: Type.String({ description: "Message to broadcast" }),
    allSessions: Type.Optional(Type.Boolean({ description: "Include agents from all sessions" })),
  }),
  async execute(_id, params) {
    const agents = params.allSessions
      ? filterStaleAgents(await readAllRegistries())
      : filterStaleAgents(await readRegistry(mySession));
    const others = agents.filter(a => !(a.name === myName && a.session === mySession));
    const formatted = `[pmux:${mySession}/${myName}] ${params.message}`;

    for (const agent of others) {
      await sendKeys(agent.pane, formatted);
    }

    const recipients = others.map(a => `${a.session}/${a.name}`);
    return {
      content: [{ type: "text", text: `Broadcast sent to ${recipients.length} agent(s): ${recipients.join(", ")}` }],
      details: { recipients },
    };
  },
});
```

### System Prompt Injection

On `before_agent_start`, inject context about the multi-agent environment, including session identity:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // Gather same-session agents
  const registry = await readRegistry(mySession);
  const sameSessionOthers = filterStaleAgents(registry).filter(a => a.name !== myName);

  // Gather cross-session agents
  const allAgents = await readAllRegistries();
  const crossSessionAgents = filterStaleAgents(allAgents).filter(a => a.session !== mySession);

  if (sameSessionOthers.length === 0 && crossSessionAgents.length === 0) return;

  let agentSection = "";

  if (sameSessionOthers.length > 0) {
    agentSection += `\nSame-session agents (address as "${mySession}/<name>" or just "<name>"):\n`;
    agentSection += sameSessionOthers.map(a =>
      `  - ${a.session}/${a.name}: ${a.role} (${a.status})`
    ).join("\n");
  }

  if (crossSessionAgents.length > 0) {
    agentSection += `\nCross-session agents (must use full "session/name" address):\n`;
    agentSection += crossSessionAgents.map(a =>
      `  - ${a.session}/${a.name}: ${a.role} (${a.status})`
    ).join("\n");
  }

  return {
    systemPrompt: event.systemPrompt + `\n\n## Multi-Agent Environment (pmux)
You are agent "${myName}" in session "${mySession}" (full address: ${mySession}/${myName}).
Role: ${myRole}.
${agentSection}

Use pmux_send to delegate tasks or ask questions.
Messages from other agents appear as "[pmux:session/agent] message".
Reply using pmux_send with the sender's address.`,
  };
});
```

### Status Widget

Show a compact agent roster in the Pi footer:

```typescript
pi.on("session_start", async (_event, ctx) => {
  await updateStatusWidget(ctx);
});

async function updateStatusWidget(ctx: ExtensionContext) {
  const agents = await readRegistry();
  const alive = filterStaleAgents(agents);
  const theme = ctx.ui.theme;

  const parts = alive.map(a => {
    const icon = a.name === myAgentName ? "◆" :
                 a.status === "working" ? "●" : "○";
    const color = a.name === myAgentName ? "accent" :
                  a.status === "working" ? "warning" : "success";
    return theme.fg(color, `${icon} ${a.name}`);
  });

  ctx.ui.setStatus("pmux", parts.join(theme.fg("dim", " │ ")));
}
```

---

## Registry Operations (registry.ts)

```typescript
import { readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const PMUX_DIR = join(homedir(), ".pmux", "sessions");

interface AgentInfo {
  name: string;
  session: string;          // pmux session this agent belongs to
  role: string;
  cwd: string;
  pane: string;             // tmux target (session:window.pane)
  pid: number;
  registeredAt: string;
  lastHeartbeat: string;
  status: "idle" | "working" | "busy";
}

type Registry = Record<string, AgentInfo>;

function registryPath(session: string): string {
  return join(PMUX_DIR, session, "agents.json");
}

// Atomic write: write to temp file, then rename
async function writeRegistry(session: string, data: Registry): Promise<void> {
  const path = registryPath(session);
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + "." + randomBytes(4).toString("hex") + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

async function readRegistry(session: string): Promise<Registry> {
  try {
    const raw = await readFile(registryPath(session), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Read ALL registries across every session.
 * Scans ~/.pmux/sessions/*/agents.json and returns a flat list.
 */
async function readAllRegistries(): Promise<AgentInfo[]> {
  const allAgents: AgentInfo[] = [];
  try {
    const sessionDirs = await readdir(PMUX_DIR, { withFileTypes: true });
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const registry = await readRegistry(entry.name);
      for (const agent of Object.values(registry)) {
        agent.session = agent.session || entry.name; // backfill
        allAgents.push(agent);
      }
    }
  } catch {}
  return allAgents;
}

// Filter agents whose heartbeat is older than maxAge (default 2 minutes)
function filterStaleAgents(agents: AgentInfo[] | Registry, maxAgeMs = 120_000): AgentInfo[] {
  const list = Array.isArray(agents) ? agents : Object.values(agents);
  const now = Date.now();
  return list.filter(a => now - new Date(a.lastHeartbeat).getTime() < maxAgeMs);
}

// --- Addressing ---

/** Format: "session/name" */
function formatAddress(session: string, name: string): string {
  return `${session}/${name}`;
}

/** Parse "name" (same-session) or "session/name" (cross-session) */
function parseAddress(address: string, defaultSession: string): { session: string; name: string } {
  const i = address.indexOf("/");
  return i === -1
    ? { session: defaultSession, name: address }
    : { session: address.slice(0, i), name: address.slice(i + 1) };
}

/**
 * Resolve an agent by address. Reads the target session's registry,
 * checks staleness, and returns the agent or null.
 */
async function resolveAgent(
  address: string, defaultSession: string, maxAgeMs = 120_000
): Promise<AgentInfo | null> {
  const { session, name } = parseAddress(address, defaultSession);
  const registry = await readRegistry(session);
  const agent = registry[name];
  if (!agent) return null;
  agent.session = agent.session || session;
  if (Date.now() - new Date(agent.lastHeartbeat).getTime() >= maxAgeMs) return null;
  return agent;
}

async function register(session: string, agent: AgentInfo): Promise<void> {
  const registry = await readRegistry(session);
  registry[agent.name] = agent;
  await writeRegistry(session, registry);
}

async function deregister(session: string, name: string): Promise<void> {
  const registry = await readRegistry(session);
  delete registry[name];
  await writeRegistry(session, registry);
}

async function heartbeat(session: string, name: string, status?: string): Promise<void> {
  const registry = await readRegistry(session);
  if (registry[name]) {
    registry[name].lastHeartbeat = new Date().toISOString();
    if (status) registry[name].status = status as AgentInfo["status"];
    await writeRegistry(session, registry);
  }
}
```

---

## tmux Helpers (tmux.ts)

```typescript
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Detect current tmux pane target
async function detectTmuxPane(): Promise<{ session: string; pane: string } | null> {
  if (!process.env.TMUX) return null;
  try {
    const { stdout: session } = await execAsync("tmux display-message -p '#{session_name}'");
    const { stdout: pane } = await execAsync(
      "tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'"
    );
    return {
      session: session.trim(),
      pane: pane.trim(),
    };
  } catch {
    return null;
  }
}

// Send keys to a tmux pane
// Messages are sent as literal strings, properly escaped
async function sendKeys(pane: string, text: string): Promise<void> {
  // Use tmux's literal flag (-l) to avoid interpreting special keys
  // Then send Enter separately
  await execAsync(`tmux send-keys -t ${shellEscape(pane)} -l ${shellEscape(text)}`);
  await execAsync(`tmux send-keys -t ${shellEscape(pane)} Enter`);
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
```

---

## Launcher (`pmux`)

The launcher is a 3-line bash shim (`bin/pmux`) that runs a TypeScript CLI (`lib/cli.ts`).
Node.js 24+ runs TypeScript natively — no compilation or extra dependencies.

```bash
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/../lib/cli.ts" "$@"
```

The CLI (`lib/cli.ts`) handles:
- `pmux` (no args) — derive session name from cwd, create tmux session, start pi
- `pmux --model <model>` — quick start with default model
- `pmux start <session> <name:dir[:role]> ...` — explicit multi-agent setup
- `pmux start --config <file.json>` — config-file-based setup with roles and model
- `pmux stop <session>` — graceful shutdown (Ctrl-C to each pane, kill session, clean registry)
- `pmux list [session]` — show session info (config, roles, agents) or list all sessions
- `pmux attach <session>` — attach to tmux session

All tmux operations use `child_process.execSync`. All file operations use built-in `node:fs`.
Config files use JSON (no YAML parser dependency).

---

## Config File Alternative

For repeatable setups, define everything in a JSON config file:

```json
{
  "session": "myproject",
  "model": "claude-sonnet-4",
  "layout": "tiled",

  "roles": {
    "frontend": {
      "instructions": "You are a React frontend developer..."
    },
    "backend": {
      "instructions": "You are a Node.js API developer..."
    },
    "devops": {
      "instructions": "You are a DevOps engineer..."
    }
  },

  "agents": {
    "frontend": { "dir": "./frontend", "role": "frontend" },
    "backend": { "dir": "./backend", "role": "backend" },
    "devops": { "dir": "./infra", "role": "devops" }
  }
}
```

Launch with:
```bash
pmux start --config pmux.json
```

---

## Agent Addressing

Every agent has a fully qualified address: `session/name`.

| Format | Scope | Example | When to use |
|--------|-------|---------|-------------|
| `name` | Same session | `"backend"` | Talking to agents in your own tmux session |
| `session/name` | Any session | `"infra/devops"` | Talking to agents in any session (required for cross-session) |

The extension resolves bare names against the sender's session.

---

## Message Protocol

Messages sent between agents always include the sender's full session-qualified address:

```
[pmux:<sender-session>/<sender-name>] <message>
```

The receiving agent sees this as a regular user prompt. The `before_agent_start` system prompt injection tells the agent how to interpret these messages and which address to use when replying.

### Example: Same-Session Conversation

**myproject/frontend** calls `pmux_send("backend", "What's the API endpoint for user auth?")`:

In **backend's** terminal:
```
[pmux:myproject/frontend] What's the API endpoint for user auth?
```

**myproject/backend** processes this, then calls `pmux_send("frontend", "POST /api/auth/login { email, password } → { token, user }")`:

In **frontend's** terminal:
```
[pmux:myproject/backend] POST /api/auth/login { email, password } → { token, user }
```

### Example: Cross-Session Conversation

**myproject/backend** calls `pmux_send("infra/devops", "Please deploy the latest backend to staging.")`:

In **infra/devops's** terminal (a completely different tmux session!):
```
[pmux:myproject/backend] Please deploy the latest backend to staging.
```

**infra/devops** replies with `pmux_send("myproject/backend", "Deployed to staging: https://staging.example.com")`:

In **myproject/backend's** terminal:
```
[pmux:infra/devops] Deployed to staging: https://staging.example.com
```

---

## Usage Examples

### Basic: Two agents, one project

```bash
pmux start myapp \
  frontend:./frontend:"React frontend developer" \
  backend:./backend:"Express API developer"
```

### Three agents with specialized roles

```bash
pmux start fullstack \
  ui:./client:"Frontend React developer. Builds UI components and pages." \
  api:./server:"Backend API developer. Builds REST endpoints and business logic." \
  db:./database:"Database specialist. Manages migrations, schemas, and queries."
```

### From within an agent (same session)

```
> Use pmux_list to see who's online, then ask the backend agent to create a new /users endpoint

# Agent calls pmux_list → sees fullstack/backend is idle
# Agent calls pmux_send("backend", "Please create a GET /users endpoint with pagination.")
# Message "[pmux:fullstack/ui] Please create a GET /users endpoint..." appears in backend's Pi terminal
# Backend agent processes the request and implements it
# Backend agent calls pmux_send("ui", "Done! GET /api/users?page=1&limit=20 is ready.")
```

### Cross-session collaboration

```bash
# Terminal 1: Start the app dev session
pmux start app \
  frontend:./frontend:"React developer" \
  backend:./backend:"API developer"

# Terminal 2: Start the infra session
pmux start infra \
  devops:./infra:"DevOps engineer" \
  dba:./database:"Database administrator"
```

```
# In the app/backend agent:
> Ask the infra devops agent to deploy staging

# Agent calls pmux_list(allSessions=true) → sees infra/devops and infra/dba
# Agent calls pmux_send("infra/devops", "Please deploy the latest backend to staging.")
# Message "[pmux:app/backend] Please deploy..." appears in devops's terminal

# In infra/devops:
# Receives the message, runs deploy, then replies:
# pmux_send("app/backend", "Deployed to https://staging.example.com")
```

---

## Edge Cases & Considerations

### Stale Agent Detection
- Heartbeat every 30 seconds
- Agents with heartbeat > 2 minutes old are filtered from `pmux_list`
- On `pmux_list`, optionally auto-clean stale entries

### Registry Race Conditions
- Atomic writes via temp file + rename prevent corruption
- Reads may see slightly stale data - acceptable for this use case
- If more robustness is needed, use `flock` for advisory locking

### Message Escaping
- Use `tmux send-keys -l` (literal mode) to avoid interpreting special tmux key names
- Shell-escape the entire string with single quotes
- Newlines: replace with spaces or use a single-line format

### Long Messages
- tmux `send-keys` has practical limits (~500 chars reliably)
- For longer messages, write to a shared temp file and send a reference:
  `[pmux:myproject/frontend] @file:/tmp/pmux/msg-abc123.md`
- The receiving agent reads the file with the `read` tool

### Agent Not Running
- If an agent's pane is dead but still in registry, `send-keys` will fail
- Catch the error and report it: "Agent 'X' appears offline"
- Combine with PID checking: `kill -0 <pid>` to verify process is alive

### Cross-Session Considerations
- Cross-session messaging works because `tmux send-keys -t` targets any pane in any tmux server session
- Each session has its own registry file; cross-session discovery scans all `~/.pmux/sessions/*/agents.json`
- Agents in different sessions may have the same name - always use fully qualified `session/name` addresses for cross-session
- If two sessions run on different tmux servers (e.g. different `TMUX_TMPDIR`), `send-keys` will not reach across them

### Multiple tmux Sessions
- Each tmux session gets its own registry under `~/.pmux/sessions/<name>/`
- Agents in different tmux sessions can see and message each other via `pmux_list(allSessions=true)` and `pmux_send("session/name", ...)`
- Same-name agents in different sessions are distinguished by their session prefix

---

## Directory Structure (Final)

```
pmux/                              # Project root
├── package.json                   # type: module
├── bin/
│   └── pmux                       # 3-line bash shim → lib/cli.ts
├── lib/
│   └── cli.ts                     # CLI implementation (TypeScript, runs on Node 24+)
├── extension/                     # Pi extension (symlink to ~/.pi/agent/extensions/pmux)
│   ├── package.json
│   ├── index.ts                   # Extension entry: lifecycle, tools, roles, commands
│   ├── registry.ts                # Registry, roles, and session config operations
│   └── tmux.ts                    # tmux detection and send-keys helpers
├── examples/
│   └── pmux.json                  # Example config with roles and model
└── docs/
    ├── design.md
    └── architecture.md

~/.pmux/sessions/                  # Runtime state (auto-created)
└── <session>/
    ├── agents.json                # Live agent registry
    ├── roles.json                 # Role definitions
    └── config.json                # Session config (default model, etc.)
```

---

## Future Enhancements

1. **Shared scratchpad**: `~/.pmux/sessions/<session>/scratchpad.md` - agents can write notes visible to all
2. **Task board**: Simple task assignment/tracking between agents
3. **File watching**: Watch `agents.json` for changes and update the widget in real-time
4. **Response protocol**: Convention for request/reply with correlation IDs
5. **Agent groups**: Tag agents and send to groups (`pmux_send("@backend-team", ...)`)
6. **Web dashboard**: Simple HTML page showing agent status and message history
7. **Message history**: Log all inter-agent messages to `~/.pmux/sessions/<session>/messages.log`
8. **Config file support**: `pmux start --config pmux.json` for repeatable setups
9. **Auto-restart**: If an agent crashes, the launcher can restart it
10. **Approval mode**: Require confirmation before executing messages from other agents

---

## Implementation Order

1. **Phase 1 - Core** (~2 hours)
   - `registry.ts` - atomic read/write/register/deregister/heartbeat
   - `tmux.ts` - pane detection, `sendKeys` helper
   - `index.ts` - extension with lifecycle hooks, `pmux_list` and `pmux_send` tools
   - Manual testing: run two Pi instances in tmux with env vars set

2. **Phase 2 — Launcher** (~1 hour)
   - `lib/cli.ts` TypeScript CLI with `start`, `stop`, `list`, `attach` commands
   - `bin/pmux` bash shim (3 lines)
   - Zero-arg quick start mode
   - Automatic env var injection per pane

3. **Phase 3 - Polish** (~1 hour)
   - Status widget in footer
   - `pmux_broadcast` tool
   - System prompt injection with agent roster
   - Long message support (file-based)
   - Stale agent cleanup
   - `/pmux` command for manual agent management

---

## Summary

pmux is intentionally simple:
- **Registry**: One JSON file per tmux session
- **Transport**: `tmux send-keys` (no network, no daemon)
- **Discovery**: Auto-detect from `$TMUX` environment
- **Integration**: Pi extension with 3 custom tools + system prompt context
- **Setup**: One bash command to start everything

The beauty is that everything is visible - you can watch agents talk to each other in real-time in your tmux panes, and you can always jump into any pane to take manual control.
