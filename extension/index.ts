/**
 * pmux — Pi Multi-Agent Coordination via tmux
 *
 * Extension entry point. Handles:
 * - Auto-registration on session start (with session identity)
 * - Heartbeat interval & deregistration on shutdown
 * - Role definitions (add/list/remove via pmux_role tool)
 * - Agent registration with a role (/pmux_register command)
 * - Default model from PMUX_MODEL env or session config
 * - System prompt injection: agent roster + role instructions
 * - Custom tools: pmux_list, pmux_send, pmux_broadcast, pmux_role
 * - Status widget showing online agents
 *
 * Agents are addressed as "name" (same session) or "session/name" (cross-session).
 * Messages include full session/name identity: [pmux:session/name]
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type AgentInfo,
  type RoleDefinition,
  readRegistry,
  readAllRegistries,
  register,
  deregister,
  updateAgent,
  updateHeartbeat,
  filterStaleAgents,
  resolveAgent,
  formatAddress,
  readRoles,
  getRole,
  addRole,
  removeRole,
  readSessionConfig,
  writeSessionConfig,
} from "./registry";
import { detectTmuxPane, sendKeys } from "./tmux";

const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 120_000;

export default function (pi: ExtensionAPI) {
  // ── State ────────────────────────────────────────────────────
  let myName: string | undefined;
  let myRole: string | undefined; // human-readable description
  let myRoleName: string | undefined; // references a RoleDefinition
  let myRoleInstructions: string | undefined; // loaded from role definition
  let mySession: string | undefined;
  let myPane: string | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let currentCtx: ExtensionContext | undefined;

  function myAddress(): string {
    return formatAddress(mySession!, myName!);
  }

  // ── Lifecycle ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    // Detect tmux environment
    const tmux = await detectTmuxPane();
    if (!tmux) {
      ctx.ui.notify("pmux: not running inside tmux — disabled", "warning");
      return;
    }

    // Resolve agent identity
    mySession = process.env.PMUX_SESSION || tmux.session;
    myName = process.env.PMUX_AGENT || deriveAgentName(ctx.cwd);
    myRole = process.env.PMUX_ROLE || `Agent in ${ctx.cwd}`;
    myPane = tmux.pane;

    // If PMUX_ROLE_NAME is set (from launcher with config), load role instructions
    const envRoleName = process.env.PMUX_ROLE_NAME;
    if (envRoleName) {
      const role = await getRole(mySession, envRoleName);
      if (role) {
        myRoleName = role.name;
        myRole = role.name;
        myRoleInstructions = role.instructions;
      }
    }

    // Register in shared registry
    const agentInfo: AgentInfo = {
      name: myName,
      session: mySession,
      role: myRole,
      roleName: myRoleName,
      cwd: ctx.cwd,
      pane: myPane,
      pid: process.pid,
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: "idle",
    };

    await register(mySession, agentInfo);

    // Start heartbeat
    heartbeatTimer = setInterval(async () => {
      if (mySession && myName) {
        await updateHeartbeat(mySession, myName).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Apply default model from PMUX_MODEL env or session config
    await applyDefaultModel(ctx);

    // Ensure session dir exists (for roles/config)
    await ensureSessionConfig(mySession);

    // Update status widget
    await refreshStatusWidget(ctx);

    const roleLabel = myRoleName ? ` (role: ${myRoleName})` : "";
    ctx.ui.notify(
      `pmux: registered as "${myAddress()}"${roleLabel} in session "${mySession}"`,
      "info"
    );
  });

  pi.on("session_shutdown", async () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (mySession && myName) {
      await deregister(mySession, myName).catch(() => {});
    }
    currentCtx = undefined;
  });

  // ── Track agent status ───────────────────────────────────────

  pi.on("agent_start", async () => {
    if (mySession && myName) {
      await updateHeartbeat(mySession, myName, "working").catch(() => {});
    }
  });

  pi.on("agent_end", async () => {
    if (mySession && myName) {
      await updateHeartbeat(mySession, myName, "idle").catch(() => {});
    }
    if (currentCtx) {
      await refreshStatusWidget(currentCtx);
    }
  });

  // ── System prompt injection ──────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    if (!mySession || !myName) return;

    let extra = "";

    // Inject role-specific instructions
    if (myRoleInstructions) {
      extra += `\n\n## Your Role: ${myRoleName}\n${myRoleInstructions}`;
    }

    // Gather same-session agents
    const registry = await readRegistry(mySession);
    const alive = filterStaleAgents(registry, STALE_THRESHOLD_MS);
    const sameSessionOthers = alive.filter((a) => a.name !== myName);

    // Gather cross-session agents
    const allAgents = await readAllRegistries();
    const allAlive = filterStaleAgents(allAgents, STALE_THRESHOLD_MS);
    const crossSessionAgents = allAlive.filter((a) => a.session !== mySession);

    const hasOthers = sameSessionOthers.length > 0 || crossSessionAgents.length > 0;

    if (!hasOthers && !myRoleInstructions) return;

    extra += `\n\n## Multi-Agent Environment (pmux)`;
    extra += `\nYou are agent "${myName}" in session "${mySession}" (full address: ${myAddress()}).`;
    if (myRoleName) {
      extra += `\nRole: ${myRoleName}.`;
    }

    if (sameSessionOthers.length > 0) {
      const list = sameSessionOthers
        .map((a) => {
          const roleLabel = a.roleName || a.role;
          return `  - ${a.name} (${formatAddress(a.session, a.name)}): ${roleLabel} [${a.status}, cwd: ${a.cwd}]`;
        })
        .join("\n");
      extra += `\n\nSame-session agents (address as "${mySession}/<name>" or just "<name>"):\n${list}`;
    }

    if (crossSessionAgents.length > 0) {
      const list = crossSessionAgents
        .map((a) => {
          const roleLabel = a.roleName || a.role;
          return `  - ${formatAddress(a.session, a.name)}: ${roleLabel} [${a.status}, cwd: ${a.cwd}]`;
        })
        .join("\n");
      extra += `\nCross-session agents (must use full address "session/name"):\n${list}`;
    }

    if (hasOthers) {
      extra += `\n
### Addressing
- Same-session agents: use just the name (e.g., "backend") or full address ("${mySession}/backend")
- Cross-session agents: always use the full address ("othersession/agentname")

### Communication
- Use pmux_send to delegate tasks or ask questions to other agents.
- Use pmux_list to refresh the list of available agents (set allSessions=true for cross-session).
- Messages from other agents appear as "[pmux:session/agent] message".
- When you receive a [pmux:...] message, treat it as a request from a teammate and respond helpfully.
- Reply using pmux_send with the sender's address.`;
    }

    return { systemPrompt: event.systemPrompt + extra };
  });

  // ── Tools ────────────────────────────────────────────────────

  // ─ pmux_role: manage role definitions ────────────────────────

  pi.registerTool({
    name: "pmux_role",
    label: "Manage Roles",
    description:
      "Add, list, or remove role definitions for the current pmux session. " +
      "Roles define a name and instructions that shape an agent's behavior. " +
      "Agents register with a role using /pmux_register.",
    promptSnippet: "Add, list, or remove pmux role definitions",
    promptGuidelines: [
      "Use pmux_role to define roles before agents register with /pmux_register.",
      "Each pmux_role has a name and instructions that guide the agent's behavior.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "list", "remove"] as const),
      name: Type.Optional(
        Type.String({ description: 'Role name (required for "add" and "remove")' })
      ),
      instructions: Type.Optional(
        Type.String({
          description:
            'Instructions for the role — what the agent should do, focus on, and how to behave (required for "add")',
        })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) {
        throw new Error("pmux is not active (not running inside tmux)");
      }

      switch (params.action) {
        case "add": {
          if (!params.name) throw new Error("Role name is required for add.");
          if (!params.instructions)
            throw new Error("Instructions are required for add.");

          const role: RoleDefinition = {
            name: params.name,
            instructions: params.instructions,
          };
          await addRole(mySession, role);

          return {
            content: [
              {
                type: "text",
                text: `Role "${params.name}" added. Agents can register with: /pmux_register ${params.name}`,
              },
            ],
            details: { role },
          };
        }

        case "list": {
          const roles = await readRoles(mySession);
          const entries = Object.values(roles);

          if (entries.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No roles defined. Use pmux_role with action=add to create one.",
                },
              ],
              details: { roles: [] },
            };
          }

          const lines = entries.map(
            (r) => `- ${r.name}: ${r.instructions.slice(0, 120)}${r.instructions.length > 120 ? "…" : ""}`
          );

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { roles: entries },
          };
        }

        case "remove": {
          if (!params.name) throw new Error("Role name is required for remove.");
          const removed = await removeRole(mySession, params.name);
          if (!removed) {
            throw new Error(
              `Role "${params.name}" not found. Use pmux_role with action=list to see available roles.`
            );
          }

          return {
            content: [
              { type: "text", text: `Role "${params.name}" removed.` },
            ],
            details: {},
          };
        }

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // ─ pmux_list ─────────────────────────────────────────────────

  pi.registerTool({
    name: "pmux_list",
    label: "List Agents",
    description:
      "List online pmux agents with their session, name, role, working directory, and status. " +
      "Set allSessions=true to include agents from other tmux sessions.",
    promptSnippet:
      "List online pmux agents and their roles/status (supports cross-session discovery)",
    parameters: Type.Object({
      allSessions: Type.Optional(
        Type.Boolean({
          description:
            "If true, list agents from all pmux sessions. Default: false (same session only).",
        })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) {
        throw new Error("pmux is not active (not running inside tmux)");
      }

      let agents: AgentInfo[];

      if (params.allSessions) {
        const all = await readAllRegistries();
        agents = filterStaleAgents(all, STALE_THRESHOLD_MS);
      } else {
        const registry = await readRegistry(mySession);
        agents = filterStaleAgents(registry, STALE_THRESHOLD_MS);
      }

      if (agents.length === 0) {
        return {
          content: [{ type: "text", text: "No agents online." }],
          details: { agents: [] },
        };
      }

      // Group by session
      const bySession = new Map<string, AgentInfo[]>();
      for (const a of agents) {
        const sess = a.session || mySession;
        if (!bySession.has(sess)) bySession.set(sess, []);
        bySession.get(sess)!.push(a);
      }

      const sections: string[] = [];
      for (const [session, sessionAgents] of bySession) {
        const isCurrent = session === mySession;
        const header = isCurrent
          ? `Session: ${session} (current)`
          : `Session: ${session}`;
        const lines = sessionAgents.map((a) => {
          const isMe = a.name === myName && a.session === mySession;
          const marker = isMe ? " (you)" : "";
          const addr = formatAddress(session, a.name);
          const roleLabel = a.roleName ? `role:${a.roleName}` : a.role;
          return `  - ${addr}${marker} [${a.status}]: ${roleLabel} (cwd: ${a.cwd})`;
        });
        sections.push(`${header}\n${lines.join("\n")}`);
      }

      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
        details: { agents },
      };
    },
  });

  // ─ pmux_send ─────────────────────────────────────────────────

  pi.registerTool({
    name: "pmux_send",
    label: "Send to Agent",
    description:
      'Send a message or instruction to another pmux agent. ' +
      'Use just the name for same-session agents (e.g., "backend") ' +
      'or "session/name" for cross-session agents (e.g., "other-project/backend"). ' +
      "The message appears as a user prompt in their Pi terminal.",
    promptSnippet:
      "Send a message to a pmux agent by name or session/name address",
    promptGuidelines: [
      "Use pmux_list first to see which agents are available before using pmux_send.",
      "When using pmux_send, be specific about what you need from the other agent.",
      'For cross-session agents, use the full address in pmux_send: "session/name".',
      "After using pmux_send, do not wait — continue with your own work unless you need their response first.",
    ],
    parameters: Type.Object({
      to: Type.String({
        description:
          'Target agent: "name" for same session, or "session/name" for cross-session',
      }),
      message: Type.String({ description: "Message or instruction to send" }),
    }),

    async execute(_id, params) {
      if (!mySession || !myName) {
        throw new Error("pmux is not active (not running inside tmux)");
      }

      const target = await resolveAgent(params.to, mySession, STALE_THRESHOLD_MS);

      if (!target) {
        const all = await readAllRegistries();
        const alive = filterStaleAgents(all, STALE_THRESHOLD_MS).filter(
          (a) => !(a.name === myName && a.session === mySession)
        );
        const available = alive.map((a) => formatAddress(a.session, a.name)).join(", ");
        throw new Error(
          `Agent "${params.to}" not found or offline. Available agents: ${available || "none"}`
        );
      }

      const targetAddr = formatAddress(target.session, target.name);
      if (targetAddr === myAddress()) {
        throw new Error("Cannot send a message to yourself.");
      }

      const formatted = `[pmux:${myAddress()}] ${params.message}`;
      await sendKeys(target.pane, formatted);

      return {
        content: [
          { type: "text", text: `Message sent to ${targetAddr} (${target.roleName || target.role}).` },
        ],
        details: {
          to: targetAddr,
          toSession: target.session,
          toName: target.name,
          pane: target.pane,
        },
      };
    },
  });

  // ─ pmux_broadcast ────────────────────────────────────────────

  pi.registerTool({
    name: "pmux_broadcast",
    label: "Broadcast",
    description:
      "Send a message to multiple online pmux agents. " +
      "By default broadcasts to same-session agents only. " +
      "Set allSessions=true to broadcast across all sessions. " +
      "Use sparingly — prefer targeted pmux_send when possible.",
    promptSnippet:
      "Broadcast a message to online pmux agents (same session or all sessions)",
    parameters: Type.Object({
      message: Type.String({ description: "Message to broadcast to agents" }),
      allSessions: Type.Optional(
        Type.Boolean({
          description:
            "If true, broadcast to agents in all sessions. Default: false (same session only).",
        })
      ),
    }),

    async execute(_id, params) {
      if (!mySession || !myName) {
        throw new Error("pmux is not active (not running inside tmux)");
      }

      let agents: AgentInfo[];
      if (params.allSessions) {
        const all = await readAllRegistries();
        agents = filterStaleAgents(all, STALE_THRESHOLD_MS);
      } else {
        const registry = await readRegistry(mySession);
        agents = filterStaleAgents(registry, STALE_THRESHOLD_MS);
      }

      const others = agents.filter(
        (a) => !(a.name === myName && a.session === mySession)
      );

      if (others.length === 0) {
        throw new Error("No other agents online to broadcast to.");
      }

      const formatted = `[pmux:${myAddress()}] ${params.message}`;
      const errors: string[] = [];

      for (const agent of others) {
        try {
          await sendKeys(agent.pane, formatted);
        } catch (err) {
          const addr = formatAddress(agent.session, agent.name);
          errors.push(`${addr}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const recipients = others.map((a) => formatAddress(a.session, a.name));
      let text = `Broadcast sent to ${recipients.length} agent(s): ${recipients.join(", ")}`;
      if (errors.length > 0) {
        text += `\nFailed for: ${errors.join("; ")}`;
      }

      return {
        content: [{ type: "text", text }],
        details: { recipients, errors },
      };
    },
  });

  // ── Commands ─────────────────────────────────────────────────

  // ─ /pmux — show status ───────────────────────────────────────

  pi.registerCommand("pmux", {
    description: "Show pmux agent status (use '/pmux all' for cross-session)",
    handler: async (args, ctx) => {
      if (!mySession || !myName) {
        ctx.ui.notify("pmux is not active (not running inside tmux)", "warning");
        return;
      }

      const showAll = args.trim() === "all";
      let agents: AgentInfo[];
      if (showAll) {
        const all = await readAllRegistries();
        agents = filterStaleAgents(all, STALE_THRESHOLD_MS);
      } else {
        const registry = await readRegistry(mySession);
        agents = filterStaleAgents(registry, STALE_THRESHOLD_MS);
      }

      const lines = agents.map((a) => {
        const isMe = a.name === myName && a.session === mySession;
        const marker = isMe ? " ◆" : "";
        const addr = formatAddress(a.session, a.name);
        const roleLabel = a.roleName || a.role;
        return `${addr}${marker} [${a.status}] — ${roleLabel}`;
      });

      const header = showAll
        ? `pmux: all sessions (you: ${myAddress()})`
        : `pmux session: ${mySession} (you: ${myAddress()})`;

      ctx.ui.notify(`${header}\n${lines.join("\n")}`, "info");
    },
  });

  // ─ /pmux_register <roleName> — register with a role ──────────

  pi.registerCommand("pmux_register", {
    description: "Register this agent with a defined role: /pmux_register <roleName>",
    handler: async (args, ctx) => {
      if (!mySession || !myName) {
        ctx.ui.notify("pmux is not active (not running inside tmux)", "warning");
        return;
      }

      const roleName = args.trim();
      if (!roleName) {
        // List available roles as a hint
        const roles = await readRoles(mySession);
        const names = Object.keys(roles);
        if (names.length === 0) {
          ctx.ui.notify(
            "Usage: /pmux_register <roleName>\n\nNo roles defined yet. Ask the LLM to create one with the pmux_role tool.",
            "warning"
          );
        } else {
          ctx.ui.notify(
            `Usage: /pmux_register <roleName>\n\nAvailable roles: ${names.join(", ")}`,
            "info"
          );
        }
        return;
      }

      // Look up the role
      const role = await getRole(mySession, roleName);
      if (!role) {
        const roles = await readRoles(mySession);
        const names = Object.keys(roles);
        const hint =
          names.length > 0
            ? `Available roles: ${names.join(", ")}`
            : "No roles defined yet. Ask the LLM to create one with the pmux_role tool.";
        ctx.ui.notify(`Role "${roleName}" not found.\n${hint}`, "error");
        return;
      }

      // Apply the role
      myRoleName = role.name;
      myRole = role.name;
      myRoleInstructions = role.instructions;

      // Update the registry
      await updateAgent(mySession, myName, {
        role: role.name,
        roleName: role.name,
      });

      await refreshStatusWidget(ctx);

      ctx.ui.notify(
        `Registered as role "${role.name}".\nInstructions will be injected into the system prompt on the next turn.`,
        "info"
      );
    },
  });

  // ── Helpers ──────────────────────────────────────────────────

  function deriveAgentName(cwd: string): string {
    const base = cwd.split("/").filter(Boolean).pop() || "agent";
    return base
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-");
  }

  async function applyDefaultModel(ctx: ExtensionContext): Promise<void> {
    // Priority: PMUX_MODEL env > session config > do nothing
    const modelStr = process.env.PMUX_MODEL;
    if (!modelStr) {
      // Check session config
      if (mySession) {
        const config = await readSessionConfig(mySession);
        if (config.model) {
          await trySetModel(ctx, config.model);
        }
      }
      return;
    }
    await trySetModel(ctx, modelStr);
  }

  async function trySetModel(ctx: ExtensionContext, modelStr: string): Promise<void> {
    // modelStr can be "provider/model" or just "model"
    // Try to find the model in the registry
    const allTools = pi.getAllTools(); // just to verify extension is loaded

    // Search by iterating models — try exact match first
    let found = false;

    if (modelStr.includes("/")) {
      const [provider, id] = modelStr.split("/", 2);
      const model = ctx.modelRegistry.find(provider, id);
      if (model) {
        const ok = await pi.setModel(model);
        if (ok) found = true;
      }
    }

    if (!found) {
      // Try to find by model ID across all providers
      // We don't have a search-all API, so we try common providers
      for (const provider of ["anthropic", "openai", "google", "local-openai"]) {
        const model = ctx.modelRegistry.find(provider, modelStr);
        if (model) {
          const ok = await pi.setModel(model);
          if (ok) {
            found = true;
            break;
          }
        }
      }
    }

    if (!found) {
      ctx.ui.notify(`pmux: could not find model "${modelStr}" — using default`, "warning");
    }
  }

  async function ensureSessionConfig(session: string): Promise<void> {
    const config = await readSessionConfig(session);
    if (!config.createdAt) {
      config.createdAt = new Date().toISOString();
      // Persist PMUX_MODEL into session config if set
      if (process.env.PMUX_MODEL && !config.model) {
        config.model = process.env.PMUX_MODEL;
      }
      await writeSessionConfig(session, config);
    }
  }

  async function refreshStatusWidget(ctx: ExtensionContext): Promise<void> {
    if (!mySession) return;

    try {
      const registry = await readRegistry(mySession);
      const alive = filterStaleAgents(registry, STALE_THRESHOLD_MS);
      const theme = ctx.ui.theme;

      const sessionLabel = theme.fg("dim", `[${mySession}] `);

      if (alive.length === 0) {
        ctx.ui.setStatus("pmux", sessionLabel + theme.fg("dim", "no agents"));
        return;
      }

      const parts = alive.map((a) => {
        const icon = a.name === myName ? "◆" : a.status === "working" ? "●" : "○";
        const color: "accent" | "warning" | "success" =
          a.name === myName ? "accent" : a.status === "working" ? "warning" : "success";
        const label = a.roleName || a.name;
        return theme.fg(color, `${icon} ${label}`);
      });

      ctx.ui.setStatus("pmux", sessionLabel + parts.join(theme.fg("dim", " │ ")));
    } catch {
      // Ignore errors in widget update
    }
  }
}
