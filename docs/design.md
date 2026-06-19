# pmux — Pi Multi-Agent Coordination

## Overview

**pmux** is a terminal-agnostic multi-agent coordination system for Pi. Agents communicate via crash-safe file-based inboxes, coordinate file access through reservations, and manage work through an integrated task backlog.

No servers, no WebSockets, no daemons — just file-based inboxes, shared JSON state, and a Pi extension.

tmux integration is optional, providing visual enhancements (pane titles, window names) but not required for communication.

---

## Architecture

```
┌────────────────────────── pmux session: "myproject" ──────────────────────────┐
│                                                                                │
│  ┌─── pi agent ──────────────┐  ┌─── pi agent ──────────────┐                │
│  │  name: frontend            │  │  name: backend             │                │
│  │  id: e02622ce              │  │  id: 49bc2403              │                │
│  │  role: developer           │  │  role: developer           │                │
│  │                            │  │                            │                │
│  │  pmux extension loaded     │  │  pmux extension loaded     │                │
│  │  tools: pmux_role,         │  │  tools: pmux_role,         │                │
│  │    pmux_list, pmux_send,   │  │    pmux_list, pmux_send,   │                │
│  │    pmux_broadcast,         │  │    pmux_broadcast,         │                │
│  │    pmux_artifacts,         │  │    pmux_artifacts,         │                │
│  │    pmux_reserve,           │  │    pmux_reserve,           │                │
│  │    pmux_task               │  │    pmux_task               │                │
│  └────────────────────────────┘  └────────────────────────────┘                │
│         ▲    │                           ▲    │                                │
│         │    ▼                           │    ▼                                │
│     ┌──────────────────────────────────────────────────────┐                   │
│     │              ~/.pmux/sessions/myproject/              │                   │
│     │  agents.json        — agent registry (UUID-keyed)     │                   │
│     │  roles.json         — role definitions                │                   │
│     │  config.json        — session config                  │                   │
│     │  reservations.json  — file/directory reservations     │                   │
│     │  backlog.json       — task backlog                    │                   │
│     │  messages.log       — message history (JSONL)         │                   │
│     │  inbox/<agentId>/   — per-agent message inboxes       │                   │
│     │  artifacts/         — shared documents                │                   │
│     └──────────────────────────────────────────────────────┘                   │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Agent Registry (`agents.json`)

Agents are identified by UUID (stable across restarts). Names are for human-friendly addressing.

```jsonc
{
  "e02622ce": {
    "id": "e02622ce",
    "name": "frontend",
    "session": "myproject",
    "team": "Home",
    "role": "developer",
    "roleName": "developer",
    "cwd": "/home/user/project/frontend",
    "pane": "myproject:0.0",         // only if tmux
    "pid": 12345,
    "status": "online",              // online | offline
    "registeredAt": "2026-06-19T10:00:00Z",
    "lastHeartbeat": "2026-06-19T10:05:32Z"
  }
}
```

### 2. File-Based Messaging (`messaging.ts`)

Crash-safe message delivery via per-agent inbox directories.

**Message lifecycle:**
1. Sender writes `.json` to target's inbox (atomic: `.tmp` → rename to `.json`)
2. Target's `FSWatcher` detects new file
3. Appends to `messages.log` (durable history)
4. Renames `.json` → `.delivered` (prevents re-delivery)
5. Delivers via `pi.sendUserMessage()` (appears in agent's conversation)
6. On `agent_end`: deletes `.delivered` files (confirmed processed)

**Crash recovery:**
- `.json` files → never picked up → deliver on startup
- `.delivered` files → queued but unconfirmed → redeliver on startup

### 3. File Reservations (`reservations.ts`)

Advisory system to prevent multi-agent file conflicts.

```jsonc
// reservations.json
{
  "src/auth/": {
    "agent": "frontend",
    "agentId": "e02622ce",
    "since": "2026-06-19T14:00:00Z",
    "reason": "TASK-03: Add input validation"
  }
}
```

**Key design decisions:**
- Trailing slash = directory prefix, no slash = exact file
- Conflict = bidirectional `startsWith` check
- Same agent can reserve nested paths (no self-conflict)
- Stale reservations (offline agents) are claimable by anyone
- Phase 1: advisory warnings on `write`/`edit` tool results (no blocking)
- Stale cleanup runs on `agent_end`

### 4. Task Backlog (`backlog.ts`)

Ordered work queue with integrated file reservations.

```jsonc
// backlog.json — array order = priority
[
  {
    "id": "TASK-01",
    "title": "Add auth middleware",
    "description": "Implement JWT validation...",
    "status": "in-progress",
    "team": "Home",
    "assignee": "frontend",
    "assigneeId": "e02622ce",
    "files": ["src/auth/middleware.ts", "src/auth/types.ts"],
    "createdBy": "architect",
    "createdAt": "2026-06-19T14:00:00Z",
    "updatedAt": "2026-06-19T14:30:00Z"
  },
  {
    "id": "TASK-02",
    "title": "Review API design",
    "status": "assigned",
    "assignee": "backend",
    "assigneeId": "49bc2403",
    ...
  }
]
```

**Task lifecycle:**
```
Self-service:  todo → pick → in-progress → done/drop
Delegated:     todo → assign → assigned → pick(by assignee) → in-progress → done/drop
Blocked:       any → block → blocked → pick → in-progress
```

**Reservation integration:**
- `pick` auto-reserves `task.files` (per-file try/catch for partial success)
- Reserve reason references task: `"TASK-03: Add input validation"`
- `done`/`drop` auto-releases file reservations
- `assign` sends inbox notification with task details + pick command

### 5. Shared Artifacts

Three-level document sharing:
- **Project** (`artifacts/project/`): visible to all agents
- **Team** (`artifacts/teams/<team>/`): visible to team members
- **Agent** (`artifacts/agents/<agentId>/`): private to one agent

Special file: `CONTEXT.md` in project/team directories is auto-injected into the system prompt.

### 6. Pi Extension (`index.ts`)

The core extension handles:
- Agent lifecycle (register, login, heartbeat, shutdown)
- 7 tool registrations (role, list, send, broadcast, artifacts, reserve, task)
- System prompt injection (roles, context, agent roster)
- Event handlers (`tool_result` for reservation warnings, `agent_end` for cleanup)
- tmux visual enhancements (optional)

---

## Tools

### `pmux_role` — Role Management

| Action | Parameters | Description |
|--------|-----------|-------------|
| `add` | name, instructions | Define a new role |
| `list` | — | Show all defined roles |
| `remove` | name | Delete a role |

### `pmux_list` — Agent Discovery

List online agents with session, name, role, team, and status.
Set `allSessions=true` for cross-session discovery.

### `pmux_send` — Targeted Messaging

Send a message by `name` (same session) or `session/name` (cross-session).
Delivered via file-based inbox — works even if target is busy or offline.

### `pmux_broadcast` — Broadcast

Send to all online agents. Set `allSessions=true` for cross-session.

### `pmux_artifacts` — Shared Documents

List documents at project, team, and agent levels.

### `pmux_reserve` — File Reservations

| Action | Parameters | Description |
|--------|-----------|-------------|
| `claim` | paths[], reason? | Reserve files/directories |
| `release` | paths[] | Release your reservations |
| `list` | — | Show all active reservations |

### `pmux_task` — Task Backlog

| Action | Parameters | Description |
|--------|-----------|-------------|
| `add` | title, description?, files?, team?, urgent? | Create task |
| `list` | status?, team? | Show backlog with filters |
| `assign` | id, to | Delegate to agent (sends notification) |
| `pick` | id?, reason? | Claim/accept task (auto-reserve files) |
| `done` | id, summary? | Complete task (auto-release files) |
| `drop` | id | Release back to queue (auto-release files) |
| `block` | id, reason | Mark task as blocked |

---

## Agent Lifecycle

```
pi starts
  └─► session_start
        ├─► Detect session (PMUX_SESSION env, tmux, or "default")
        ├─► Auto-register from PMUX_AGENT env, or recover from pi session entries
        │   (or wait for /pmux_register or /pmux_login)
        ├─► Go online, start heartbeat (30s interval)
        ├─► Ensure inbox directory, artifact directories
        ├─► Start inbox FSWatcher — deliver messages via pi.sendUserMessage
        ├─► Deliver pending + crash-recovery messages
        └─► Set tmux titles and status widget (optional)

pi running
  ├─► before_agent_start → inject system prompt (roles, context, agents)
  ├─► agent_start → update heartbeat
  ├─► agent_end   → update heartbeat, confirm delivered messages,
  │                  clean stale reservations
  ├─► tool_result → check file reservations on write/edit, inject warnings
  └─► tools available: 7 tools (see above)

pi exits
  └─► session_shutdown
        ├─► Stop heartbeat, close inbox watcher
        └─► Go offline (unless reloading — keep online for recovery)
```

### Agent Identity Recovery

- On `/reload`: UUID recovered from pi session entries → resume as same agent
- On restart: PMUX_AGENT env → find existing offline agent → login
- On crash: `.delivered` files in inbox → redeliver on next startup

---

## Agent Addressing

Every agent has a fully qualified address: `session/name`.

| Format | Scope | Example |
|--------|-------|---------|
| `name` | Same session | `"backend"` |
| `session/name` | Cross-session | `"infra/devops"` |

## Message Format

```
[pmux:<sender-session>/<sender-name> (<role>)] <message>
```

---

## Directory Structure

```
pmux/                              # Project root
├── package.json                   # type: module, pi extension config
├── README.md
├── bin/
│   └── pmux                       # Bash shim → lib/cli.ts
├── lib/
│   └── cli.ts                     # CLI (TypeScript, Node 24+)
├── extension/                     # Pi extension
│   ├── package.json
│   ├── index.ts                   # Lifecycle, tools, commands, events
│   ├── registry.ts                # Agent registry, roles, session config
│   ├── messaging.ts               # File-based inbox messaging
│   ├── reservations.ts            # File/directory reservations
│   ├── backlog.ts                 # Task backlog management
│   └── tmux.ts                    # tmux detection (optional)
├── examples/
│   └── pmux.json                  # Example config
└── docs/
    ├── design.md                  # This document
    └── architecture.md            # Architecture overview

~/.pmux/sessions/                  # Runtime state (auto-created)
└── <session>/
    ├── agents.json                # Agent registry (UUID-keyed)
    ├── roles.json                 # Role definitions
    ├── config.json                # Session config
    ├── reservations.json          # File reservations
    ├── backlog.json               # Task backlog
    ├── messages.log               # Message history (JSONL)
    ├── inbox/                     # Per-agent message inboxes
    │   └── <agentId>/
    │       ├── <timestamp>-<id>.json       # Pending message
    │       └── <timestamp>-<id>.delivered  # Delivered, awaiting confirmation
    └── artifacts/
        ├── project/               # Shared across all agents
        ├── teams/<team>/          # Shared within team
        └── agents/<agentId>/      # Private to agent
```

---

## Design Decisions

### File-Based Communication (not tmux send-keys)

Early versions used `tmux send-keys` to deliver messages. This was replaced with file-based inboxes because:
- **Terminal-agnostic**: works without tmux
- **Crash-safe**: messages persist on disk, survive process crashes
- **Reliable delivery**: FSWatcher + startup recovery ensures no message loss
- **History**: JSONL log provides audit trail

### UUID-Based Agent Identity (not name-based)

Agents are keyed by UUID in the registry, not by name. This allows:
- Stable identity across restarts (UUID persists, name can change)
- Multiple agents can have the same name in different sessions
- Clean separation between identity (UUID) and addressing (name)

### Advisory Reservations (Phase 1)

File reservations warn but don't block. This is intentional for Phase 1:
- Avoids workflow deadlocks from bugs in the reservation system
- Agents can still make emergency edits
- Warnings are actionable (include who reserved and why)
- Phase 2 will add enforced mode with override capability

### Task Backlog: Array Order = Priority

Tasks are stored as an ordered array, not with numeric priority fields. This avoids:
- Renumbering when inserting between priorities
- Priority collision (two tasks with same number)
- The first unassigned `"todo"` task is always the highest priority

### Pick = Accept

The `pick` action doubles as task acceptance for assigned tasks. This avoids separate `accept`/`decline` tools:
- `pick()` with no ID → grab the next todo (self-service)
- `pick(id)` where task is assigned to me → accept the assignment
- Decline is a social interaction (message the architect), not a state transition

---

## Future Enhancements

1. **Enforced reservations (Phase 2)**: Block writes to reserved files with `force` override
2. **Cached online agent IDs**: Cache in heartbeat timer for zero-cost tool_result checks
3. **Task dependencies**: `dependsOn` field for sequencing
4. **Web dashboard**: HTML page showing agent status and task board
5. **Agent groups**: Tag agents and send to groups (`@backend-team`)
6. **Auto-restart**: Launcher restarts crashed agents
