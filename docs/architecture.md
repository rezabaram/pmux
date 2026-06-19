# Architecture

## Component Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              pmux system                                     │
│                                                                              │
│  ┌─── session: "project-a" ──────────────────────────────────────────────┐   │
│  │  ┌──── pi agent ─────────┐     ┌──── pi agent ─────────┐            │   │
│  │  │  name: frontend        │     │  name: backend         │            │   │
│  │  │  role: frontend        │────▶│  role: backend          │            │   │
│  │  │  addr: project-a/      │◀────│  addr: project-a/      │            │   │
│  │  │       frontend         │     │       backend           │            │   │
│  │  └────────────────────────┘     └────────────────────────┘            │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│         │                                    │                               │
│         │           cross-session             │                               │
│         ▼                                    ▼                               │
│  ┌─── session: "infra" ─────────────────────────────────────────────────┐   │
│  │  ┌──── pi agent ─────────┐                                           │   │
│  │  │  name: devops          │                                           │   │
│  │  │  role: devops          │                                           │   │
│  │  │  addr: infra/devops    │                                           │   │
│  │  └────────────────────────┘                                           │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐     │
│  │                    ~/.pmux/sessions/                                  │     │
│  │  project-a/                                                          │     │
│  │    agents.json        ← agent registry (keyed by UUID)               │     │
│  │    roles.json         ← role definitions                             │     │
│  │    config.json        ← session config (model, etc.)                 │     │
│  │    reservations.json  ← file/directory reservations                  │     │
│  │    backlog.json       ← task backlog (ordered array)                 │     │
│  │    messages.log       ← message history (JSONL)                      │     │
│  │    inbox/             ← per-agent message inboxes                    │     │
│  │    artifacts/         ← shared documents                             │     │
│  │  infra/                                                              │     │
│  │    agents.json        ← agent registry                               │     │
│  │    roles.json         ← role definitions                             │     │
│  │    ...                                                               │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Communication: File-Based Inboxes

Agents communicate via crash-safe file-based inboxes — no tmux dependency.

```
Agent A calls pmux_send("backend", "add a /health endpoint")
  → Resolves target agent from agents.json
  → Writes message as .json file to target's inbox:
      ~/.pmux/sessions/<session>/inbox/<targetId>/<timestamp>-<msgId>.json
  → Target's inbox watcher detects new file
  → Appends to messages.log (history)
  → Renames .json → .delivered (prevents re-delivery)
  → Delivers to target via pi.sendUserMessage()
  → On agent_end: .delivered files are confirmed (deleted)
```

### Crash Safety

| State | Recovery |
|-------|----------|
| `.json` files in inbox | Never picked up → deliver on startup |
| `.delivered` files in inbox | Queued but unconfirmed → redeliver on startup |
| Messages in `messages.log` | Durable history for audit |

## Session Files

Each session stores its state under `~/.pmux/sessions/<session>/`:

| File / Directory | Format | Purpose |
|------------------|--------|---------|
| `agents.json` | `Record<UUID, AgentInfo>` | Agent registry (keyed by UUID) |
| `roles.json` | `Record<name, RoleDefinition>` | Role definitions with instructions |
| `config.json` | `SessionConfig` | Default model and session metadata |
| `reservations.json` | `Record<path, Reservation>` | File/directory reservations |
| `backlog.json` | `Task[]` | Task backlog (array order = priority) |
| `messages.log` | JSONL | Message history (append-only) |
| `inbox/<agentId>/` | `.json` / `.delivered` files | Per-agent message inbox |
| `artifacts/project/` | user files | Shared project documents |
| `artifacts/teams/<team>/` | user files | Team-level shared documents |
| `artifacts/agents/<agentId>/` | user files | Private agent documents |

## Agent Tools (7 total)

| Tool | Actions | Purpose |
|------|---------|---------|
| `pmux_role` | add, list, remove | Manage role definitions |
| `pmux_list` | — | Discover online agents |
| `pmux_send` | — | Send message to agent |
| `pmux_broadcast` | — | Broadcast to all agents |
| `pmux_artifacts` | — | List shared documents |
| `pmux_reserve` | claim, release, list | File/directory reservations |
| `pmux_task` | add, list, assign, pick, done, drop, block | Task backlog management |

## Extension Modules

```
extension/
├── index.ts             # Entry point: lifecycle, tools, commands, event handlers
├── registry.ts          # Agent registry, roles, session config (atomic JSON I/O)
├── messaging.ts         # File-based inbox system (crash-safe delivery)
├── reservations.ts      # File/directory reservation system
├── backlog.ts           # Task backlog management
├── tmux.ts              # tmux detection (optional — visual enhancements only)
└── package.json
```

## Data Flow

### Messaging (File-Based Inboxes)

```
pmux_send("backend", "message")
  → resolveAgent("backend", mySession)
    → Read agents.json → find agent by name → get UUID + session
  → Create InboxMessage { id, from, fromName, fromRole, fromSession, timestamp, message }
  → Atomic write to inbox: .tmp → rename to .json
  → Target's FSWatcher fires
    → Read .json → append to messages.log → rename to .delivered
    → pi.sendUserMessage() delivers to agent's conversation
  → On agent_end: delete .delivered files (confirmed)
```

### File Reservations

```
pmux_reserve({ action: "claim", paths: ["src/auth/"], reason: "refactoring" })
  → Normalize paths (preserve trailing slash convention)
  → Read reservations.json
  → Check overlap: pathA.startsWith(pathB) || pathB.startsWith(pathA)
  → Same agent = no conflict; stale reservation (offline agent) = claimable
  → Write reservation with { agent, agentId, since, reason }
  → On write/edit tool_result: check conflict, prepend ⚠️ warning if reserved

Stale cleanup:
  → On agent_end: get online agent IDs, remove reservations held by offline agents
```

### Task Backlog

```
pmux_task({ action: "add", title: "...", files: [...] })
  → Generate next ID: TASK-01, TASK-02, etc.
  → Append to backlog.json (or prepend if urgent)

pmux_task({ action: "assign", id: "TASK-03", to: "backend" })
  → Set status: "assigned", set assignee
  → Send notification to assignee via inbox (with pick command)

pmux_task({ action: "pick", id: "TASK-03" })
  → If assigned to me: accept (status → "in-progress")
  → If no ID: grab first "todo" task
  → Auto-reserve task.files (per-file, partial success)
  → Reserve reason: "TASK-03: <title>"

pmux_task({ action: "done", id: "TASK-03", summary: "..." })
  → Set status: "done", capture summary + completedAt
  → Auto-release file reservations

Task lifecycle:
  Self-service:  todo → pick → in-progress → done/drop
  Delegated:     todo → assign → assigned → pick(by assignee) → in-progress → done/drop
  Blocked:       any → block → blocked → pick → in-progress
```

### System Prompt Injection

On `before_agent_start`, the extension injects:
- Role instructions (from roles.json)
- Project/team context (from CONTEXT.md artifacts)
- Available roles summary
- Online agent roster with addressing instructions
- Communication guidelines
- Artifact paths

## Agent Identity

Agents are identified by UUID (stable across restarts), not by name.

```jsonc
// agents.json (keyed by UUID)
{
  "e02622ce": {
    "id": "e02622ce",
    "name": "frontend",
    "session": "myproject",
    "team": "Home",
    "role": "developer",
    "roleName": "developer",
    "cwd": "/home/user/project",
    "pane": "myproject:0.0",    // only if tmux
    "pid": 12345,
    "status": "online",         // online | offline
    "registeredAt": "2026-06-19T10:00:00Z",
    "lastHeartbeat": "2026-06-19T10:05:32Z"
  }
}
```

## Agent Lifecycle

```
pi starts
  └─► session_start
        ├─► Detect session (env var or tmux or "default")
        ├─► Auto-register from PMUX_AGENT env (or wait for /pmux_register)
        ├─► Go online, start heartbeat (30s interval)
        ├─► Watch inbox for new messages
        ├─► Deliver pending + crash-recovery messages
        └─► Set tmux titles (optional)

pi running
  ├─► agent_start → update heartbeat
  ├─► agent_end   → update heartbeat, confirm delivered messages,
  │                  clean stale reservations
  └─► tools: pmux_role, pmux_list, pmux_send, pmux_broadcast,
             pmux_artifacts, pmux_reserve, pmux_task

pi exits
  └─► session_shutdown
        ├─► Stop heartbeat, close inbox watcher
        └─► Go offline (unless reloading — keep online for recovery)
```

## Agent Addressing

| Format | Scope | Example |
|--------|-------|---------|
| `name` | Same session | `"backend"` |
| `session/name` | Cross-session | `"infra/devops"` |

## Message Format

```
[pmux:<sender-session>/<sender-name> (<role>)] <message>
```

Example:
```
[pmux:project-a/frontend (developer)] Can you create a /health endpoint?
```
