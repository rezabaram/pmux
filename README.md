# pmux — Pi Multi-Agent Coordination

Coordinate multiple [Pi](https://github.com/earendil-works/pi) agents across terminals. Agents discover each other, communicate via file-based inboxes, share documents, manage tasks, and build shared knowledge — all from within Pi.

No servers, no daemons, no extra dependencies. Just a Pi extension.

## Install

```bash
pi install git:github.com/rezabaram/pmux
```

That's it. Start Pi in any terminal and you're ready.

## Quick Start

```bash
# Terminal 1
pi
/pmux_join              # → select/create project → select/create agent (name, role)

# Terminal 2
pi
/pmux_join              # → join same project → another agent joins

# They discover each other and can communicate
# When done:
/pmux_leave             # → back to solo Pi
```

## How It Works

1. **Join** — `/pmux_join` selects or creates a project, then picks or creates an agent
2. **Communicate** — `pmux_send` delivers messages to other agents' inboxes via `fs.watch`
3. **Coordinate** — `pmux_task` manages a shared backlog with auto file reservations
4. **Learn** — `pmux_journal` captures decisions and learnings, injected into every agent's prompt
5. **Leave** — `/pmux_leave` exits the project, returns to normal solo Pi

All communication is file-based (`~/.pmux/sessions/<session>/inbox/`). Messages are delivered instantly via filesystem notifications — no polling, no servers.

## Commands

| Command | Purpose |
|---------|---------|
| `/pmux` | Show agent status |
| `/pmux_join [project]` | Join or create a project (interactive wizard) |
| `/pmux_leave` | Leave project, return to solo Pi |

## Tools (8)

| Tool | Actions | Purpose |
|------|---------|---------|
| `pmux_role` | add, list, remove | Define roles with instructions |
| `pmux_list` | — | List online agents |
| `pmux_send` | — | Send message to an agent |
| `pmux_broadcast` | — | Broadcast to all agents |
| `pmux_artifacts` | — | List shared documents |
| `pmux_reserve` | claim, release, list | File/directory reservations |
| `pmux_task` | add, list, assign, pick, done, drop, block | Task backlog management |
| `pmux_journal` | add, list | Record decisions and learnings |

## Agent Addressing

| Format | Scope | Example |
|--------|-------|---------|
| `name` | Same project | `"Negin"` |
| `project/name` | Cross-project | `"myproject/Negin"` |

## Session Files

```
~/.pmux/sessions/<project>/
├── agents.json           # Agent registry (UUID-keyed, online/offline)
├── roles.json            # Role definitions
├── config.json           # Session config
├── backlog.json          # Task backlog (ordered array)
├── reservations.json     # File reservations
├── journal.jsonl         # Decisions & learnings (append-only)
├── messages.log          # Message history
├── inbox/
│   └── <agent-uuid>/     # Per-agent message inbox
└── artifacts/
    ├── project/           # Shared across all agents
    │   └── CONTEXT.md     # Auto-injected into prompts
    └── agents/<uuid>/     # Private per-agent space
```

## Key Features

- **Zero overhead** — Pi starts normally, pmux is invisible until `/pmux_join`
- **Terminal agnostic** — works in any terminal, any environment
- **UUID identity** — agents persist across restarts
- **Crash-safe messaging** — messages survive crashes, delivered on reconnect
- **File reservations** — claim files before editing, prevent conflicts
- **Task backlog** — assign, pick, done with auto file reservation
- **Shared journal** — decisions and learnings in every agent's prompt
- **Two-tier artifacts — project and private document sharing
- **CONTEXT.md injection** — project context auto-loaded into prompts
- **Zero dependencies** — just Node.js and Pi

## Extension Structure

```
extension/
├── index.ts             # Lifecycle, 8 tools, 3 commands
├── registry.ts          # Agent identity (UUID-keyed, online/offline)
├── messaging.ts         # Crash-safe file-based inboxes
├── reservations.ts      # Path-prefix file reservations
├── backlog.ts           # Ordered task queue
├── journal.ts           # Append-only decision/learning log
└── package.json
```

## Requirements

- **Pi** (coding agent)
- **Node.js 22+**

## License

MIT
