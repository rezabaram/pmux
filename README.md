# pmux — Pi Multi-Agent Coordination via tmux

Run multiple [Pi](https://github.com/earendil-works/pi) agents in tmux panes. They discover each other automatically and communicate by typing messages into each other's terminals — even across different tmux sessions.

No servers, no daemons, no extra dependencies — just tmux, Node.js, and a Pi extension.

## Install

### Option 1: Pi package (recommended)

```bash
# Install the extension
pi install git:github.com/rezabaram/pmux

# Add the CLI to your PATH (pick one)
ln -s ~/.pi/agent/git/github.com/rezabaram/pmux/bin/pmux ~/.local/bin/pmux
# or
echo 'export PATH="$PATH:$HOME/.pi/agent/git/github.com/rezabaram/pmux/bin"' >> ~/.bashrc
```

### Option 2: Clone

```bash
git clone https://github.com/rezabaram/pmux.git ~/pmux
ln -s ~/pmux/extension ~/.pi/agent/extensions/pmux
ln -s ~/pmux/bin/pmux ~/.local/bin/pmux
```

## Quick Start — Incremental Workflow

The simplest way to start: no config files, build the environment as you go.

```bash
pmux
```

You're now in a tmux session with Pi running:

```
# Step 1: Define roles (ask the LLM or type directly)
> Create a pmux role called "frontend" with instructions to focus on React UI development

# Step 2: Split the terminal and start another pi
#   Press Ctrl-B %  (tmux horizontal split)
#   In the new pane, type: pi

# Step 3: In the new pi, register with the role
/pmux_register frontend

# Step 4: Repeat for more agents — split, start pi, register
```

That's it. No config file needed. Agents discover each other automatically.

## Quick Start — Config File

For repeatable setups, define everything in a JSON config file:

```bash
pmux start --config pmux.json
```

See [examples/pmux.json](examples/pmux.json) for the format (roles, model, agents).

## How It Works

1. **Launcher** (`pmux`) creates a tmux session and starts Pi
2. **Roles** define instructions that shape agent behavior (created via tool or config)
3. **Agents** register with roles using `/pmux_register <roleName>` (or auto-assigned from config)
4. The **Pi extension** auto-registers agents in a shared JSON registry
5. Agents use custom tools (`pmux_list`, `pmux_send`, `pmux_broadcast`) to talk
6. Messages are delivered via `tmux send-keys` — they appear as user prompts
7. **Cross-session**: agents in different tmux sessions can discover and message each other

## Agent Addressing

Every agent has a fully qualified address: `session/name`.

| Format | Scope | Example |
|--------|-------|---------|
| `name` | Same session | `"backend"` |
| `session/name` | Cross-session | `"infra/devops"` |

## Roles

Roles are named definitions with instructions that guide an agent's behavior.

**Create roles interactively** (inside pi):
```
> Create a pmux role called "backend" with instructions: "You are a Node.js API developer. Build REST endpoints and business logic."
```
The LLM uses the `pmux_role` tool to add it.

**Create roles from config** (in JSON file):
```json
{
  "roles": {
    "backend": {
      "instructions": "You are a Node.js API developer..."
    }
  }
}
```

**Register an agent with a role**:
```
/pmux_register backend
```

## Default Model

Set a default model for all agents:

```bash
# Via command line
pmux --model claude-sonnet-4
```

Per-agent model override is supported in the config file:
```json
{
  "model": "claude-sonnet-4",
  "agents": {
    "frontend": { "dir": "./frontend", "role": "frontend", "model": "claude-opus-4" }
  }
}
```

## Agent Tools

| Tool | Description |
|------|-------------|
| `pmux_role` | Add, list, or remove role definitions for the session |
| `pmux_list` | List online agents — same session or all sessions (`allSessions=true`) |
| `pmux_send` | Send a message by `name` (same session) or `session/name` (cross-session) |
| `pmux_broadcast` | Broadcast to agents — same session or all sessions (`allSessions=true`) |

## Commands

| Command | Description |
|---------|-------------|
| `/pmux` | Show agent status (use `/pmux all` for cross-session) |
| `/pmux_register <role>` | Register this agent with a defined role |

## Launcher Commands

```bash
pmux                                          # Quick start in current directory
pmux --model <model>                          # Quick start with default model
pmux --session <name>                         # Quick start with custom session name
pmux start <session> <name:dir[:role]> ...    # Start with explicit agents
pmux start --config <file.json>               # Start from JSON config file
pmux stop  <session>                          # Stop all agents and kill session
pmux list  [session]                          # Show session info (or list all sessions)
pmux attach <session>                         # Attach to the tmux session
```

## Environment Variables

Set by the launcher (or manually):

| Variable | Purpose | Example |
|----------|---------|---------|
| `PMUX_SESSION` | Session name / registry namespace | `myproject` |
| `PMUX_AGENT` | Agent name (unique within session) | `frontend` |
| `PMUX_ROLE_NAME` | Role to auto-register with | `frontend` |
| `PMUX_MODEL` | Default model for the agent | `claude-sonnet-4` |

If `PMUX_SESSION` is not set, the extension auto-detects from the tmux session name.

## Requirements

- **Node.js 24+** (for native TypeScript support in the CLI)
- **tmux** (the transport layer)
- **Pi** (the coding agent)

No other dependencies. No Python, no npm install.

## Project Structure

```
pmux/
├── package.json             # type: module
├── README.md
├── docs/
│   ├── design.md            # Full design document
│   └── architecture.md      # Architecture overview
├── lib/
│   └── cli.ts               # CLI implementation (TypeScript)
├── extension/               # Pi extension (symlink to ~/.pi/agent/extensions/pmux)
│   ├── package.json
│   ├── index.ts             # Extension: lifecycle, tools, roles, commands
│   ├── registry.ts          # Registry, roles, and session config operations
│   └── tmux.ts              # tmux detection & send-keys helpers
├── bin/
│   └── pmux                 # 3-line bash shim → lib/cli.ts
└── examples/
    └── pmux.json            # Example config with roles and model
```

## Session Files

Each session stores its state in `~/.pmux/sessions/<session>/`:

| File | Purpose |
|------|---------|
| `agents.json` | Live agent registry (auto-managed) |
| `roles.json` | Role definitions (name + instructions) |
| `config.json` | Session config (default model, etc.) |

## Documentation

- [Design Document](docs/design.md) — Full design rationale and protocol details
- [Architecture](docs/architecture.md) — Component overview and data flow

## License

MIT
