# pmux — Pi Multi-Agent Coordination

Coordinate multiple [Pi](https://github.com/earendil-works/pi) agents across terminals. Agents discover each other, communicate via file-based inboxes, share documents, manage tasks, and build shared knowledge — all from within Pi.

No servers, no daemons, no tmux dependency. Just a Pi extension.

## Install

```bash
pi install git:github.com/rezabaram/pmux
```

That's it. Start Pi in any terminal and you're ready.

## Quick Start

```bash
# Terminal 1
pi
/pmux_register          # → pick name, team, role (interactive wizard)

# Terminal 2
pi
/pmux_register          # → another agent joins

# They discover each other and can communicate
```

## How It Works

1. **Register** — `/pmux_register` creates your agent identity (UUID, name, team, role)
2. **Communicate** — `pmux_send` delivers messages to other agents' inboxes via `fs.watch`
3. **Coordinate** — `pmux_task` manages a shared backlog with auto file reservations
4. **Learn** — `pmux_journal` captures decisions and learnings, injected into every agent's prompt

All communication is file-based (`~/.pmux/sessions/<session>/inbox/`). Messages are delivered instantly via filesystem notifications — no polling, no servers.

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

## Commands

| Command | Purpose |
|---------|---------|
| `/pmux` | Show agent status |
| `/pmux_register` | Create new agent (interactive) |
| `/pmux_login` | Resume existing agent |

## Agent Addressing

| Format | Scope | Example |
|--------|-------|---------|
| `name` | Same session | `"Negin"` |
| `session/name` | Cross-session | `"myproject/Negin"` |

## Session Files

```
~/.pmux/sessions/<session>/
├── agents.json           # Agent registry (UUID-keyed)
├── roles.json            # Role definitions
├── config.json           # Session config
├── backlog.json          # Task backlog
├── reservations.json     # File reservations
├── journal.jsonl         # Decisions & learnings log
├── messages.log          # Message history
├── inbox/
│   └── <agent-uuid>/     # Per-agent message inbox
└── artifacts/
    ├── project/           # Shared across all agents
    │   └── CONTEXT.md     # Auto-injected into prompts
    ├── teams/<team>/      # Shared within team
    │   └── CONTEXT.md     # Auto-injected for team members
    └── agents/<uuid>/     # Private per-agent space
```

## Key Features

- **Terminal agnostic** — works in any terminal, any environment
- **UUID identity** — agents persist across restarts (`/pmux_login`)
- **Crash-safe messaging** — messages survive crashes, delivered on reconnect
- **File reservations** — claim files before editing, prevent conflicts
- **Task backlog** — assign, pick, done with auto file reservation
- **Shared journal** — decisions and learnings in every agent's prompt
- **Three-tier artifacts** — project, team, and private document sharing
- **CONTEXT.md injection** — project and team context auto-loaded into prompts
- **Zero dependencies** — just Node.js and Pi

## Requirements

- **Pi** (coding agent)
- **Node.js 22+**

## License

MIT
