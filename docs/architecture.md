# Architecture

## Component Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              pmux system                                     │
│                                                                              │
│  ┌─── project: "myproject" ──────────────────────────────────────────────┐   │
│  │  ┌──── pi agent ─────────┐     ┌──── pi agent ─────────┐            │   │
│  │  │  name: frontend        │     │  name: backend         │            │   │
│  │  │  role: developer       │────▶│  role: developer        │            │   │
│  │  │  team: Home            │◀────│  team: Home             │            │   │
│  │  └────────────────────────┘     └────────────────────────┘            │   │
│  │           │ file-based inbox            │                              │   │
│  └───────────┼─────────────────────────────┼─────────────────────────────┘   │
│              │                             │                                 │
│  ┌───────────┴─────────────────────────────┴─────────────────────────────┐   │
│  │                    ~/.pmux/sessions/myproject/                         │   │
│  │  agents.json · roles.json · config.json · reservations.json           │   │
│  │  backlog.json · journal.jsonl · messages.log                          │   │
│  │  inbox/<uuid>/ · artifacts/                                           │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Extension Modules

```
extension/
├── index.ts             # Entry point: lifecycle, 8 tools, 3 commands
├── registry.ts          # Agent identity (UUID-keyed), roles, session config
├── messaging.ts         # Crash-safe file-based inboxes (fs.watch)
├── reservations.ts      # Path-prefix file/directory reservations
├── backlog.ts           # Ordered task queue
├── journal.ts           # Append-only decision/learning log
└── package.json
```

## Commands (3)

| Command | Purpose |
|---------|---------|
| `/pmux` | Show agent status |
| `/pmux_join [project]` | Join or create a project (select/create agent) |
| `/pmux_leave` | Leave project, return to solo Pi |

## Tools (8)

| Tool | Actions | Purpose |
|------|---------|---------|
| `pmux_role` | add, list, remove | Manage role definitions |
| `pmux_list` | — | Discover online agents |
| `pmux_send` | — | Send message to agent |
| `pmux_broadcast` | — | Broadcast to all agents |
| `pmux_artifacts` | — | List shared documents |
| `pmux_reserve` | claim, release, list | File/directory reservations |
| `pmux_task` | add, list, assign, pick, done, drop, block | Task backlog management |
| `pmux_journal` | add, list | Record decisions and learnings |

## Session Files

| File / Directory | Format | Purpose |
|------------------|--------|---------|
| `agents.json` | `Record<UUID, AgentInfo>` | Agent registry |
| `roles.json` | `Record<name, RoleDefinition>` | Role definitions |
| `config.json` | `SessionConfig` | Session metadata |
| `reservations.json` | `Record<path, Reservation>` | File reservations |
| `backlog.json` | `Task[]` | Task backlog (array order = priority) |
| `journal.jsonl` | JSONL | Decisions & learnings (append-only) |
| `messages.log` | JSONL | Message history (append-only) |
| `inbox/<uuid>/` | `.json` / `.delivered` | Per-agent message inbox |
| `artifacts/project/` | user files | Project-wide shared docs |
| `artifacts/teams/<team>/` | user files | Team shared docs |
| `artifacts/agents/<uuid>/` | user files | Private agent docs |

## Agent Lifecycle

```
pi starts
  └─► session_start (silent — no notifications, no auto-registration)
        └─► Reload recovery only: check pi session entries for stored UUID

/pmux_join
  ├─► Select or create project
  ├─► Select existing agent or create new (name, team, role)
  ├─► Go online, start heartbeat (30s)
  ├─► Watch inbox for messages (fs.watch)
  ├─► Deliver pending + crash-recovery messages
  └─► Inject role/context into system prompt

pi running
  ├─► before_agent_start → inject role, context, agents, journal
  ├─► agent_end → heartbeat, confirm messages, clean stale reservations
  └─► tools available: 8 tools for coordination

/pmux_leave
  ├─► Go offline in registry
  ├─► Stop heartbeat, close inbox watcher
  ├─► Clear all state
  └─► Return to solo Pi (silent)

pi exits
  └─► session_shutdown
        └─► Go offline (unless reloading — keep online for recovery)
```

## Data Flows

### Messaging

```
pmux_send("backend", "message")
  → resolveAgent("backend") → find UUID from agents.json
  → Write .tmp → rename to .json (atomic) in target's inbox/
  → Target's FSWatcher fires
    → Append to messages.log
    → Rename .json → .delivered
    → pi.sendUserMessage({ deliverAs: "followUp" })
  → On agent_end: delete .delivered (confirmed)
```

### File Reservations

```
pmux_reserve({ action: "claim", paths: ["src/auth/"] })
  → Check overlap: pathA.startsWith(pathB) || pathB.startsWith(pathA)
  → Stale (offline agent) = claimable
  → On write/edit: tool_result prepends ⚠️ warning if reserved

Cleanup: agent_end removes reservations held by offline agents
```

### Task Backlog

```
add → append to backlog.json (prepend if urgent)
assign → status: "assigned" + inbox notification with pick command
pick → status: "in-progress" + auto-reserve task files (partial success)
done → status: "done" + auto-release reservations + capture summary
drop → status: "todo" + auto-release reservations

Lifecycle:
  Self-service:  todo → pick → in-progress → done/drop
  Delegated:     todo → assign → assigned → pick(by assignee) → in-progress → done/drop
```

### Journal

```
pmux_journal({ action: "add", type: "decision", content: "..." })
  → Append to journal.jsonl (sync, append-only)
  → Last 10 entries auto-injected into system prompt (sliding window)
  → All agents see shared decisions, learnings, progress
```

### System Prompt Injection

On each turn (`before_agent_start`), the extension injects:
1. Role instructions (from `roles.json`)
2. Project context (from `artifacts/project/CONTEXT.md`)
3. Team context (from `artifacts/teams/<team>/CONTEXT.md`)
4. Recent journal entries (last 10, sliding window)
5. Available roles summary
6. Online agent roster
7. Addressing and communication guidelines
8. Artifact paths

## Agent Identity

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
    "pid": 12345,
    "status": "online",
    "registeredAt": "2026-06-19T10:00:00Z",
    "lastHeartbeat": "2026-06-19T10:05:32Z"
  }
}
```

## Agent Addressing

| Format | Scope | Example |
|--------|-------|---------|
| `name` | Same project | `"backend"` |
| `project/name` | Cross-project | `"infra/devops"` |

## Message Format

```
[pmux:<project>/<name> (<role>)] <message>
```
