# Architecture

## Component Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              pmux system                                     │
│                                                                              │
│  ┌─── tmux session: "project-a" ─────────────────────────────────────────┐   │
│  │  ┌──── pane 0.0 ─────────┐     ┌──── pane 0.1 ─────────┐            │   │
│  │  │  pi (frontend)         │     │  pi (backend)          │            │   │
│  │  │  role: frontend        │────▶│  role: backend          │            │   │
│  │  │  addr: project-a/      │◀────│  addr: project-a/      │            │   │
│  │  │       frontend         │     │       backend           │            │   │
│  │  └────────────────────────┘     └────────────────────────┘            │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│         │                                    │                               │
│         │           cross-session             │                               │
│         ▼                                    ▼                               │
│  ┌─── tmux session: "infra" ─────────────────────────────────────────────┐   │
│  │  ┌──── pane 0.0 ─────────┐                                           │   │
│  │  │  pi (devops)           │                                           │   │
│  │  │  role: devops          │                                           │   │
│  │  │  addr: infra/devops    │                                           │   │
│  │  └────────────────────────┘                                           │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐     │
│  │                    ~/.pmux/sessions/                                  │     │
│  │  project-a/                                                          │     │
│  │    agents.json   ← live agent registry                               │     │
│  │    roles.json    ← role definitions (frontend, backend)              │     │
│  │    config.json   ← session config (model, etc.)                      │     │
│  │  infra/                                                              │     │
│  │    agents.json   ← live agent registry                               │     │
│  │    roles.json    ← role definitions (devops)                         │     │
│  │    config.json   ← session config                                    │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Session Files

Each session stores three files under `~/.pmux/sessions/<session>/`:

| File | Format | Purpose |
|------|--------|---------|
| `agents.json` | `Record<name, AgentInfo>` | Live agent registry (auto-managed) |
| `roles.json` | `Record<name, RoleDefinition>` | Role definitions with instructions |
| `config.json` | `SessionConfig` | Default model and session metadata |

## Data Flow

### Incremental Setup (no config file)

```
User runs `pmux`
  → Derives session name from cwd basename
  → Creates tmux session, writes config.json
  → Starts pi in first pane
  → Extension registers agent in agents.json

User (inside pi): "Create a role called frontend with instructions..."
  → LLM calls pmux_role tool (action: add)
  → Role written to roles.json

User: Ctrl-B % (split pane), starts `pi`
  → Extension registers new agent

User (new pane): /pmux_register frontend
  → Looks up "frontend" in roles.json
  → Updates agent record with roleName
  → Role instructions injected into system prompt on next turn
```

### Config-Based Setup (JSON)

```
User runs `pmux start --config pmux.json`
  → Parses JSON config: session, model, roles, agents
  → Writes roles.json and config.json
  → Creates tmux panes, sets env vars per agent
  → Each pi instance auto-registers with assigned role via PMUX_ROLE_NAME
```

### Model Selection

```
Priority chain:
  1. Per-agent PMUX_MODEL env (from config agent.model override)
  2. Session PMUX_MODEL env (from config model or --model flag)
  3. Session config.json model field
  4. Pi's default model (no change)
```

### Same-Session Messaging

```
Agent "project-a/frontend" calls pmux_send(to="backend", message="...")
  → parseAddress("backend", defaultSession="project-a")
    → { session: "project-a", name: "backend" }
  → Read project-a/agents.json → find "backend" → get pane target
  → Format: "[pmux:project-a/frontend] ..."
  → tmux send-keys -t project-a:0.1 -l '<message>' Enter
```

### Cross-Session Messaging

```
Agent "project-a/frontend" calls pmux_send(to="infra/devops", message="...")
  → parseAddress("infra/devops", defaultSession="project-a")
    → { session: "infra", name: "devops" }
  → Read infra/agents.json → find "devops" → get pane target
  → Format: "[pmux:project-a/frontend] ..."
  → tmux send-keys -t infra:0.0 -l '<message>' Enter
```

### Deregistration

```
Pi exits (Ctrl+C, Ctrl+D, etc.)
  → Extension session_shutdown fires
  → Remove agent from agents.json
  → Clear heartbeat interval
```

## Registry Format

```jsonc
// agents.json
{
  "frontend": {
    "name": "frontend",
    "session": "myproject",
    "role": "frontend",           // role name or description
    "roleName": "frontend",       // references roles.json entry
    "cwd": "/home/user/project/frontend",
    "pane": "myproject:0.0",
    "pid": 12345,
    "registeredAt": "2026-06-19T10:00:00Z",
    "lastHeartbeat": "2026-06-19T10:05:32Z",
    "status": "idle"
  }
}

// roles.json
{
  "frontend": {
    "name": "frontend",
    "instructions": "You are a React frontend developer. Focus on UI components..."
  }
}

// config.json
{
  "model": "claude-sonnet-4",
  "createdAt": "2026-06-19T10:00:00Z"
}
```

## Agent Addressing

| Format | Scope | Example | When to use |
|--------|-------|---------|-------------|
| `name` | Same session | `"backend"` | Talking to agents in your session |
| `session/name` | Any session | `"infra/devops"` | Talking across sessions |

## Message Protocol

```
[pmux:<sender-session>/<sender-name>] <free-form message text>
```

Examples:
```
[pmux:project-a/frontend] Can you create a /health endpoint?
[pmux:infra/devops] The staging deploy succeeded.
```
