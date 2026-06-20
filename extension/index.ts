/**
 * pmux  -- Pi Multi-Agent Coordination
 *
 * Terminal-agnostic multi-agent coordination for Pi.
 * Communication uses file-based inboxes.
 *
 * Agent lifecycle:
 *   /pmux join       -- join or create a project, pick or create an agent
 *   session shutdown  -- agent goes offline (persists for later)
 *
 * Tools: pmux_role, pmux_list, pmux_send, pmux_broadcast,
 *         pmux_reserve, pmux_task, pmux_journal
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { FSWatcher } from "node:fs";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type AgentInfo,
  type RoleDefinition,
  readRegistry,
  readAllRegistries,
  registerAgent,
  removeAgent,
  updateAgent,
  updateHeartbeat,
  goOnline,
  goOffline,
  newAgentId,
  findByName,
  findById,
  getOnlineAgents,
  getOfflineAgents,
  resolveAgent,
  formatAddress,
  readRoles,
  getRole,
  addRole,
  removeRole,
  readSessionConfig,
  writeSessionConfig,
} from "./registry";
import {
  ensureInbox,
  sendToInbox,
  getRecoverableMessages,
  markAsDelivered,
  confirmDelivered,
  appendToHistory,
  watchInbox,
  newMessageId,
  type InboxMessage,
} from "./messaging";
import {
  reserve,
  release,
  getReservations,
  checkConflict,
  clearStaleReservations,
} from "./reservations";
import {
  type Task,
  readBacklog,
  writeBacklog,
  addTask,
  nextTaskId,
} from "./backlog";
import {
  appendEntry as addJournalEntry,
  readEntries as readJournalEntries,
  getRecentEntries,
  formatEntry as formatJournalEntry,
} from "./journal";

const HEARTBEAT_INTERVAL_MS = 30_000;

const BUILTIN_ROLES: RoleDefinition[] = [
  {
    name: "developer",
    description: "Write clean, well-structured code",
    instructions: "You are a software developer. Focus on writing clean, well-structured code. Follow best practices for the project's language and framework. Write tests when appropriate. Read existing code before making changes to understand patterns and conventions. Coordinate with other agents when your changes affect shared interfaces.",
  },
  {
    name: "architect",
    description: "System design, trade-offs, technical decisions",
    instructions: "You are a software architect. Focus on system design, high-level structure, and technical decision-making. Evaluate trade-offs between approaches. Define interfaces, data models, and component boundaries. Review code for architectural consistency. Guide other agents on design patterns, project organization, and scalability concerns. Think about maintainability, extensibility, and separation of concerns.",
  },
  {
    name: "reviewer",
    description: "Code review, quality, constructive feedback",
    instructions: "You are a code reviewer. Review code for correctness, clarity, performance, and adherence to project conventions. Provide constructive, specific feedback. Identify potential bugs, security issues, and edge cases. Suggest improvements without being prescriptive. Approve when quality standards are met.",
  },
  {
    name: "devops",
    description: "Infrastructure, CI/CD, deployment",
    instructions: "You are a DevOps engineer. Manage infrastructure, CI/CD pipelines, deployment scripts, and configuration. Focus on reliability, security, and automation. Monitor for performance issues. Write infrastructure as code. Ensure environments are reproducible and deployments are safe.",
  },
  {
    name: "planner",
    description: "Task breakdown, requirements, coordination",
    instructions: "You are a project planner. Break down features into actionable tasks with clear descriptions. Define requirements and acceptance criteria in task descriptions. Coordinate work across agents. Track progress and identify blockers. Keep the backlog organized and prioritized.",
  },
];


export default function (pi: ExtensionAPI) {
  // -- State ----------------------------------------------------
  let myId: string | undefined; // UUID  -- stable across restarts
  let myName: string | undefined;
  let myRole: string | undefined;
  let myRoleName: string | undefined;
  let myRoleInstructions: string | undefined;
  let mySession: string | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let inboxWatcher: FSWatcher | undefined;
  let currentCtx: ExtensionContext | undefined;

  function myAddress(): string {
    return formatAddress(mySession!, myName!);
  }

  function myPrefix(): string {
    const addr = myAddress();
    return myRoleName ? `[pmux:${addr} (${myRoleName})]` : `[pmux:${addr}]`;
  }

  // -- Agent Startup/Shutdown Helpers ---------------------------

  /** Common setup after register or login. */
  async function startAgent(ctx: ExtensionContext): Promise<void> {
    if (!myId || !mySession || !myName) return;

    // Mark online
    await goOnline(mySession, myId, process.pid);

    // Ensure inbox and artifact directories exist
    ensureInbox(mySession, myId);
    ensureArtifactDirs();

    // Start heartbeat
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      if (mySession && myId) {
        await updateHeartbeat(mySession, myId).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Start inbox watcher  -- deliver messages via pi.sendUserMessage
    if (inboxWatcher) inboxWatcher.close();
    inboxWatcher = watchInbox(mySession, myId, (msg, filename) => {
      // Crash-safe: history first, then mark delivered, then queue
      appendToHistory(mySession!, msg);
      markAsDelivered(mySession!, myId!, filename);

      const prefix = msg.fromRole
        ? `[pmux:${msg.fromSession}/${msg.fromName} (${msg.fromRole})]`
        : `[pmux:${msg.fromSession}/${msg.fromName}]`;
      pi.sendUserMessage(`${prefix} ${msg.message}`, {
        deliverAs: "followUp",
      });
    });

    // Deliver pending + crash-recovery messages
    const recoverable = getRecoverableMessages(mySession, myId);
    for (const { msg, filename } of recoverable) {
      // Only append to history for new messages (not already-delivered ones)
      if (filename.endsWith(".json")) {
        appendToHistory(mySession, msg);
        markAsDelivered(mySession, myId, filename);
      }

      const prefix = msg.fromRole
        ? `[pmux:${msg.fromSession}/${msg.fromName} (${msg.fromRole})]`
        : `[pmux:${msg.fromSession}/${msg.fromName}]`;
      pi.sendUserMessage(`${prefix} ${msg.message}`, {
        deliverAs: "followUp",
      });
    }

    // Persist UUID in pi session (survives /reload)
    pi.appendEntry("pmux-agent", { id: myId, session: mySession });

    // Update titles and status widget
    updateTitles(ctx);
    await refreshStatusWidget(ctx);
  }

  /** Cleanup on shutdown. */
  function stopAgent(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (inboxWatcher) {
      inboxWatcher.close();
      inboxWatcher = undefined;
    }
  }

  function updateTitles(ctx: ExtensionContext): void {
    const name = myName ?? "pi";
    const title = myRoleName ? `${name} (${myRoleName})` : name;
    ctx.ui.setTitle(title);
  }

  /** Load role instructions from roles.json. */
  async function loadRoleInstructions(session: string, roleName: string): Promise<boolean> {
    const role = await getRole(session, roleName);
    if (!role) return false;
    myRoleName = role.name;
    myRole = role.name;
    myRoleInstructions = role.instructions;
    return true;
  }

  // -- Lifecycle ------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    // Reload recovery: check pi session entries for stored agent
    let recoveredId: string | undefined;
    let recoveredSession: string | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "pmux-agent") {
        const data = entry.data as { id: string; session: string };
        recoveredId = data.id;
        recoveredSession = data.session;
      }
    }

    if (recoveredId && recoveredSession) {
      const agent = await findById(recoveredSession, recoveredId);
      if (agent) {
        mySession = recoveredSession;
        myId = agent.id;
        myName = agent.name;
        myRole = agent.role;
        if (agent.roleName) {
          await loadRoleInstructions(mySession, agent.roleName);
        }
        await startAgent(ctx);
        return;
      }
    }

    // Otherwise: silent. Use /pmux join to get started.
  });

  pi.on("session_shutdown", async (event) => {
    stopAgent();

    // Mark offline (unless reloading  -- keep online for recovery)
    if (event.reason !== "reload" && mySession && myId) {
      await goOffline(mySession, myId).catch(() => {});
    }

    currentCtx = undefined;
  });

  // -- Agent Status Tracking ------------------------------------

  pi.on("agent_start", async () => {
    if (mySession && myId) {
      await updateHeartbeat(mySession, myId).catch(() => {});
    }
  });

  pi.on("agent_end", async () => {
    if (mySession && myId) {
      await updateHeartbeat(mySession, myId).catch(() => {});
      // Clean up .delivered files  -- messages confirmed processed
      confirmDelivered(mySession, myId);
      // Clean up stale reservations (held by offline agents)
      const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
      const onlineIds = online.map((a) => a.id);
      await clearStaleReservations(mySession, onlineIds).catch(() => {});
    }
    if (currentCtx) {
      await refreshStatusWidget(currentCtx);
    }
  });

  // -- File Reservation Warnings --------------------------------

  pi.on("tool_result", async (event) => {
    if (!mySession || !myId) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const filePath = (event.input as Record<string, unknown>).path as string | undefined;
    if (!filePath) return;

    // Get online agent IDs for stale detection
    const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
    const onlineIds = online.map((a) => a.id);

    const conflict = await checkConflict(mySession, filePath, myId, onlineIds);
    if (!conflict) return;

    const { reservedPath, reservation, stale } = conflict;
    const reasonStr = reservation.reason ? ` (${reservation.reason})` : "";
    const staleNote = stale ? " [agent offline  -- stale reservation]" : "";
    const warning =
      `⚠️ ${filePath} is reserved by ${reservation.agent}${reasonStr}${staleNote}. ` +
      `Consider coordinating via pmux_send('${reservation.agent}', ...).`;

    // Prepend warning to result content
    return {
      content: [
        { type: "text" as const, text: warning },
        ...event.content,
      ],
    };
  });

  // -- System Prompt Injection ----------------------------------

  pi.on("before_agent_start", async (event) => {
    if (!mySession || !myName) return;

    let extra = "";

    // Inject role instructions
    if (myRoleInstructions) {
      extra += `\n\n## Your Role: ${myRoleName}\n${myRoleInstructions}`;
    }

    // Inject workspace info
    if (myId) {
      const agent = await findById(mySession, myId);
      if (agent?.workspace) {
        const branchResult = await pi.exec("git", ["-C", agent.workspace, "branch", "--show-current"], { timeout: 5000 });
        const branch = branchResult.stdout?.trim() || "unknown";
        extra += `\n\n## Your Workspace\nPath: ${agent.workspace}\nBranch: ${branch}\nUse this as your working directory for all file operations.`;
      }
    }

    // Inject project context (CONTEXT.md)
    const projectCtx = readContextFile(projectArtifactsDir());
    if (projectCtx) {
      extra += `\n\n## Project Context\n${projectCtx}`;
    }

    // Inject recent journal entries (sliding window)
    const recentJournal = getRecentEntries(mySession);
    if (recentJournal.length > 0) {
      const journalLines = recentJournal.map((e) => `- ${formatJournalEntry(e)}`);
      extra += `\n\n## Recent Journal\n${journalLines.join("\n")}`;
    }

    // Gather all agents in this project (online + offline)
    const registry = await readRegistry(mySession);
    const projectAgents = Object.values(registry).filter((a) => a.id !== myId);

    // Cross-session agents (online only)
    const allAgents = await readAllRegistries();
    const crossSessionAgents = allAgents.filter(
      (a) => a.session !== mySession && a.status === "online"
    );

    const hasOthers = projectAgents.length > 0 || crossSessionAgents.length > 0;

    if (!hasOthers && !extra) return;

    if (hasOthers) {
      extra += `\n\n## Multi-Agent Environment (pmux)`;
      extra += `\nYou are agent "${myName}" in session "${mySession}" (full address: ${myAddress()}).`;
      if (myRoleName) extra += `\nRole: ${myRoleName}.`;

      if (projectAgents.length > 0) {
        const list = projectAgents
          .map((a) => {
            const roleLabel = a.roleName || a.role;
            return `  - ${a.name} (${roleLabel}) [${a.status}]`;
          })
          .join("\n");
        extra += `\n\nSame-session agents (address as "${mySession}/<name>" or just "<name>"):\n${list}`;
      }


      if (crossSessionAgents.length > 0) {
        const list = crossSessionAgents
          .map((a) => {
            const parts = [a.roleName || a.role, a.name].filter(Boolean);
            return `  - ${formatAddress(a.session, a.name)}: ${parts.join(":")} [${a.status}]`;
          })
          .join("\n");
        extra += `\nCross-session agents (must use full address "session/name"):\n${list}`;
      }

      extra += `\n
### Addressing
- Same-session agents: use just the name (e.g., "backend") or full address ("${mySession}/backend")
- Cross-session agents: always use the full address ("othersession/agentname")

### Communication
- Use pmux_send to delegate tasks or ask questions to other agents.
- Use pmux_list to refresh the list of available agents (set allSessions=true for cross-session).
- Messages from other agents appear as "[pmux:session/agent (role)] message".
- When you receive a [pmux:...] message, treat it as a request from a teammate and respond helpfully.
- Reply using pmux_send with the sender's address.`;
    }

    // Artifact paths  -- always include when agent has identity
    if (myId) {
      extra += `\n\n### Shared Artifacts\nRead and write shared documents using the standard read/write/edit tools.`;
      extra += `\n- Project (all agents): ${projectArtifactsDir()}`;
      extra += `\n- Private (you only): ${agentArtifactsDir(myId)}`;
    }

    return { systemPrompt: event.systemPrompt + extra };
  });

  // -- Tools ----------------------------------------------------

  // - pmux_role -------------------------------------------------

  pi.registerTool({
    name: "pmux_role",
    label: "Manage Roles",
    description:
      "Add, list, or remove role definitions for the current pmux session. " +
      "Roles define a name and instructions that shape an agent's behavior. " +
      "Agents join projects with /pmux join.",
    promptSnippet: "Add, list, or remove pmux role definitions",
    promptGuidelines: [
      "Use pmux_role to define roles before agents join with /pmux join.",
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
            'Instructions for the role  -- what the agent should do, focus on, and how to behave (required for "add")',
        })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("pmux session not active");

      switch (params.action) {
        case "add": {
          if (!params.name) throw new Error("Role name is required for add.");
          if (!params.instructions) throw new Error("Instructions are required for add.");
          await addRole(mySession, { name: params.name, instructions: params.instructions });
          return {
            content: [{ type: "text", text: `Role "${params.name}" added. Agents can join with: /pmux join` }],
            details: { role: { name: params.name, instructions: params.instructions } },
          };
        }
        case "list": {
          const roles = await readRoles(mySession);
          const entries = Object.values(roles);
          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: "No roles defined. Use pmux_role with action=add to create one." }],
              details: { roles: [] },
            };
          }
          const lines = entries.map(
            (r) => `- ${r.name}: ${r.instructions.slice(0, 120)}${r.instructions.length > 120 ? "…" : ""}`
          );
          return { content: [{ type: "text", text: lines.join("\n") }], details: { roles: entries } };
        }
        case "remove": {
          if (!params.name) throw new Error("Role name is required for remove.");
          const removed = await removeRole(mySession, params.name);
          if (!removed) throw new Error(`Role "${params.name}" not found.`);
          return { content: [{ type: "text", text: `Role "${params.name}" removed.` }], details: {} };
        }
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // - pmux_list -------------------------------------------------

  pi.registerTool({
    name: "pmux_list",
    label: "List Agents",
    description:
      "List online pmux agents with their session, name, role, and status. " +
      "Set allSessions=true to include agents from other sessions.",
    promptSnippet: "List online pmux agents and their roles/status (supports cross-session discovery)",
    parameters: Type.Object({
      allSessions: Type.Optional(
        Type.Boolean({ description: "If true, list agents from all sessions. Default: false." })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("pmux session not active");

      let agents: AgentInfo[];
      if (params.allSessions) {
        agents = (await readAllRegistries()).filter((a) => a.status === "online");
      } else {
        agents = await getOnlineAgents(mySession);
      }

      if (agents.length === 0) {
        return { content: [{ type: "text", text: "No agents online." }], details: { agents: [] } };
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
        const header = isCurrent ? `Session: ${session} (current)` : `Session: ${session}`;
        const lines = sessionAgents.map((a) => {
          const isMe = a.id === myId;
          const marker = isMe ? " (you)" : "";
          const addr = formatAddress(session, a.name);
          const label = [a.roleName, a.name].filter(Boolean).join(":");
          return `  - ${addr}${marker} [${a.status}]: ${label} (cwd: ${a.cwd})`;
        });
        sections.push(`${header}\n${lines.join("\n")}`);
      }

      return { content: [{ type: "text", text: sections.join("\n\n") }], details: { agents } };
    },
  });

  // - pmux_send -------------------------------------------------

  pi.registerTool({
    name: "pmux_send",
    label: "Send to Agent",
    description:
      'Send a message to another pmux agent. Use "name" for same-session or "session/name" for cross-session. ' +
      "Delivered to the agent's inbox  -- works even if they're busy or offline.",
    promptSnippet: "Send a message to a pmux agent by name or session/name address",
    promptGuidelines: [
      "Use pmux_list first to see which agents are available before using pmux_send.",
      "When using pmux_send, be specific about what you need from the other agent.",
      'For cross-session agents, use the full address in pmux_send: "session/name".',
      "After using pmux_send, do not wait  -- continue with your own work unless you need their response first.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: '"name" for same session, or "session/name" for cross-session' }),
      message: Type.String({ description: "Message or instruction to send" }),
    }),

    async execute(_id, params) {
      if (!mySession || !myId || !myName) {
        throw new Error("Not registered. Use /pmux join first.");
      }

      const target = await resolveAgent(params.to, mySession);
      if (!target) {
        const all = await readAllRegistries();
        const online = all.filter((a) => a.status === "online" && a.id !== myId);
        const available = online.map((a) => formatAddress(a.session, a.name)).join(", ");
        throw new Error(`Agent "${params.to}" not found. Available: ${available || "none"}`);
      }

      if (target.id === myId) throw new Error("Cannot send a message to yourself.");

      const msg: InboxMessage = {
        id: newMessageId(),
        from: myId,
        fromName: myName,
        fromRole: myRoleName,
        fromSession: mySession,
        timestamp: new Date().toISOString(),
        message: params.message,
      };

      sendToInbox(target.session, target.id, msg);

      const targetAddr = formatAddress(target.session, target.name);
      return {
        content: [{ type: "text", text: `Message sent to ${targetAddr} (${target.roleName || target.role}).` }],
        details: { to: targetAddr, targetId: target.id },
      };
    },
  });

  // - pmux_broadcast --------------------------------------------

  pi.registerTool({
    name: "pmux_broadcast",
    label: "Broadcast",
    description:
      "Send a message to all other online agents. Set allSessions=true for cross-session. " +
      "Use sparingly  -- prefer targeted pmux_send.",
    promptSnippet: "Broadcast a message to online pmux agents",
    parameters: Type.Object({
      message: Type.String({ description: "Message to broadcast" }),
      allSessions: Type.Optional(
        Type.Boolean({ description: "Broadcast to all sessions. Default: false." })
      ),
    }),

    async execute(_id, params) {
      if (!mySession || !myId || !myName) {
        throw new Error("Not registered. Use /pmux join first.");
      }

      let agents: AgentInfo[];
      if (params.allSessions) {
        agents = (await readAllRegistries()).filter((a) => a.status === "online");
      } else {
        agents = await getOnlineAgents(mySession);
      }

      const others = agents.filter((a) => a.id !== myId);
      if (others.length === 0) throw new Error("No other agents online.");

      const errors: string[] = [];
      for (const agent of others) {
        try {
          const msg: InboxMessage = {
            id: newMessageId(),
            from: myId,
            fromName: myName,
            fromRole: myRoleName,
            fromSession: mySession,
            timestamp: new Date().toISOString(),
            message: params.message,
          };
          sendToInbox(agent.session, agent.id, msg);
        } catch (err) {
          errors.push(`${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const recipients = others.map((a) => formatAddress(a.session, a.name));
      let text = `Broadcast sent to ${recipients.length} agent(s): ${recipients.join(", ")}`;
      if (errors.length > 0) text += `\nFailed: ${errors.join("; ")}`;

      return { content: [{ type: "text", text }], details: { recipients, errors } };
    },
  });

  // - pmux_artifacts --------------------------------------------

  pi.registerTool({
    name: "pmux_artifacts",
    label: "List Artifacts",
    description:
      "List shared documents at project and agent levels. " +
      "Use read/write/edit tools to work with the files directly.",
    promptSnippet: "List shared artifacts at project or agent level",
    parameters: Type.Object({}),

    async execute() {
      if (!mySession || !myId) {
        throw new Error("Not registered. Use /pmux join first.");
      }

      const sections: string[] = [];

      // Project level
      const projDir = projectArtifactsDir();
      const projFiles = listFiles(projDir);
      sections.push(`Project (${projDir}):\n` +
        (projFiles.length > 0 ? projFiles.map((f) => `  - ${f}`).join("\n") : "  (empty)"));


      // Agent level
      const aDir = agentArtifactsDir(myId);
      const aFiles = listFiles(aDir);
      sections.push(`Private (${aDir}):\n` +
        (aFiles.length > 0 ? aFiles.map((f) => `  - ${f}`).join("\n") : "  (empty)"));

      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
      };
    },
  });

  // - pmux_reserve ----------------------------------------------

  pi.registerTool({
    name: "pmux_reserve",
    label: "File Reservations",
    description:
      "Manage file/directory reservations to prevent conflicts. " +
      "Actions: claim (reserve paths), release (free paths), list (show all). " +
      "Trailing slash = directory prefix, no slash = exact file.",
    promptSnippet: "Manage file reservations  -- claim, release, list",
    promptGuidelines: [
      "Use pmux_reserve with action 'claim' before editing files other agents might work on.",
      "Trailing slash = directory prefix (e.g., 'src/auth/'), no slash = exact file.",
      "Release reservations with action 'release' when done editing.",
    ],
    parameters: Type.Object({
      action: StringEnum(["claim", "release", "list"] as const),
      paths: Type.Optional(
        Type.Array(Type.String({ description: "Paths to claim or release (trailing slash = directory prefix)" }))
      ),
      reason: Type.Optional(
        Type.String({ description: "Why you're claiming these paths (shown to other agents)" })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("pmux session not active");

      switch (params.action) {
        case "claim": {
          if (!myId || !myName) throw new Error("Not registered. Use /pmux join first.");
          if (!params.paths?.length) throw new Error("Paths are required for claim.");

          const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
          const onlineIds = online.map((a) => a.id);

          const reserved = await reserve(mySession, params.paths, myId, myName, params.reason, onlineIds);

          const reasonNote = params.reason ? ` (${params.reason})` : "";
          return {
            content: [{
              type: "text",
              text: `Reserved ${reserved.length} path(s)${reasonNote}:\n${reserved.map((p) => `  ✓ ${p}`).join("\n")}`,
            }],
            details: { reserved, reason: params.reason },
          };
        }

        case "release": {
          if (!myId) throw new Error("Not registered. Use /pmux join first.");
          if (!params.paths?.length) throw new Error("Paths are required for release.");

          const released = await release(mySession, params.paths, myId);

          if (released.length === 0) {
            return {
              content: [{ type: "text", text: "No matching reservations found to release." }],
              details: { released: [] },
            };
          }
          return {
            content: [{
              type: "text",
              text: `Released ${released.length} reservation(s):\n${released.map((p) => `  ✓ ${p}`).join("\n")}`,
            }],
            details: { released },
          };
        }

        case "list": {
          const reservations = await getReservations(mySession);
          const entries = Object.entries(reservations);

          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: "No active reservations." }],
              details: { reservations: {} },
            };
          }

          const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
          const onlineIds = new Set(online.map((a) => a.id));

          const now = Date.now();
          const lines = entries.map(([path, res]) => {
            const elapsed = now - new Date(res.since).getTime();
            const duration = formatDuration(elapsed);
            const reasonStr = res.reason ? `  -- ${res.reason}` : "";
            const stale = !onlineIds.has(res.agentId);
            const staleStr = stale ? " [stale  -- agent offline]" : "";
            const isMe = res.agentId === myId;
            const marker = isMe ? " (you)" : "";
            return `  ${path}  →  ${res.agent}${marker}${reasonStr} (${duration})${staleStr}`;
          });

          return {
            content: [{ type: "text", text: `Active reservations:\n${lines.join("\n")}` }],
            details: { reservations },
          };
        }

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // - pmux_task -------------------------------------------------

  pi.registerTool({
    name: "pmux_task",
    label: "Task Backlog",
    description:
      "Manage the task backlog. Actions: add (create task), list (show tasks), " +
      "assign (delegate to agent), pick (claim/accept task), done (complete), " +
      "drop (release back to queue), block (mark blocked). " +
      "Picking a task auto-reserves its files. Done/drop auto-releases them.",
    promptSnippet: "Manage task backlog  -- add, list, assign, pick, done, drop, block",
    promptGuidelines: [
      "Use action 'pick' to claim the next available task or accept an assigned task.",
      "Picking a task auto-reserves its files. Done/drop auto-releases them.",
      "Use action 'done' with a summary when completing a task.",
      "Use action 'assign' to delegate tasks  -- the assignee accepts by picking.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "list", "assign", "pick", "done", "drop", "block"] as const),
      // add
      title: Type.Optional(Type.String({ description: "Task title (required for add)" })),
      description: Type.Optional(Type.String({ description: "Task description or acceptance criteria" })),
      files: Type.Optional(Type.Array(Type.String({ description: "Related file paths (auto-reserved on pick)" }))),
      urgent: Type.Optional(Type.Boolean({ description: "If true, prepend to backlog instead of append" })),
      // assign, pick, done, drop, block
      id: Type.Optional(Type.String({ description: "Task ID (e.g. TASK-01)" })),
      to: Type.Optional(Type.String({ description: "Agent name to assign the task to" })),
      reason: Type.Optional(Type.String({ description: "Reason for blocking, or approach note for pick" })),
      summary: Type.Optional(Type.String({ description: "Completion summary (for done)" })),
      // list
      status: Type.Optional(Type.String({ description: "Filter by status: todo, assigned, in-progress, done, blocked" })),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("pmux session not active");

      switch (params.action) {
        // -- add ----------------------------------------------
        case "add": {
          if (!myName) throw new Error("Not registered. Use /pmux join first.");
          if (!params.title) throw new Error("Title is required for add.");

          const now = new Date().toISOString();
          const task = await addTask(
            mySession,
            {
              title: params.title,
              description: params.description,
              status: "todo",
              files: params.files,
              createdBy: myName,
              createdAt: now,
              updatedAt: now,
            },
            params.urgent
          );

          const urgentNote = params.urgent ? " (urgent  -- top of backlog)" : "";
          const filesNote = task.files?.length ? `\n  Files: ${task.files.join(", ")}` : "";
          return {
            content: [{
              type: "text",
              text: `Created ${task.id}: ${task.title}${urgentNote}${filesNote}`,
            }],
            details: { task },
          };
        }

        // -- list ---------------------------------------------
        case "list": {
          const tasks = await readBacklog(mySession);
          let filtered = tasks;

          if (params.status) {
            filtered = filtered.filter((t) => t.status === params.status);
          }

          if (filtered.length === 0) {
            const filterNote = params.status ? ` with status "${params.status}"` : "";
            return {
              content: [{ type: "text", text: `No tasks found${filterNote}.` }],
              details: { tasks: [] },
            };
          }

          const lines = filtered.map((t, i) => {
            const pos = tasks.indexOf(t) + 1;
            const assigneeStr = t.assignee
              ? t.status === "assigned"
                ? ` → ${t.assignee} (pending)`
                : `  -- ${t.assignee}`
              : "";
            const isMe = t.assigneeId === myId;
            const meMarker = isMe ? " (you)" : "";
            const filesStr = t.files?.length ? `\n                              Files: ${t.files.join(", ")}` : "";
            const blockedStr = t.status === "blocked" && t.blockedReason
              ? `\n                              Blocked: ${t.blockedReason}` : "";
            const summaryStr = t.status === "done" && t.summary
              ? `\n                              Summary: ${t.summary}` : "";
            const doneTime = t.status === "done" && t.completedAt
              ? ` (${formatDuration(Date.now() - new Date(t.completedAt).getTime())} ago)` : "";

            return `  #${String(pos).padStart(2)}  ${t.id}  [${t.status}]  ${t.title}${assigneeStr}${meMarker}${doneTime}${filesStr}${blockedStr}${summaryStr}`;
          });

          return {
            content: [{ type: "text", text: `Backlog (${filtered.length} task${filtered.length !== 1 ? "s" : ""}):\n\n${lines.join("\n")}` }],
            details: { tasks: filtered },
          };
        }

        // -- assign -------------------------------------------
        case "assign": {
          if (!myId || !myName) throw new Error("Not registered. Use /pmux join first.");
          if (!params.id) throw new Error("Task ID is required for assign.");
          if (!params.to) throw new Error("Target agent name is required for assign.");

          const tasks = await readBacklog(mySession);
          const task = tasks.find((t) => t.id === params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);

          if (task.status === "in-progress") {
            throw new Error(
              `${params.id} is actively being worked on by ${task.assignee}. Ask them to drop it first.`
            );
          }
          if (task.status === "done") {
            throw new Error(`${params.id} is already done.`);
          }

          const target = await resolveAgent(params.to, mySession);
          if (!target) {
            throw new Error(`Agent "${params.to}" not found.`);
          }

          task.status = "assigned";
          task.assignee = target.name;
          task.assigneeId = target.id;
          task.updatedAt = new Date().toISOString();
          await writeBacklog(mySession, tasks);

          // Send notification to assignee
          const filesStr = task.files?.length ? `\nFiles: ${task.files.join(", ")}` : "";
          const descStr = task.description ? `\n${task.description}` : "";
          const notification =
            `📋 Task assigned to you:\n${task.id}: ${task.title}${descStr}${filesStr}` +
            `\n\n→ Use pmux_task with action "pick" and id "${task.id}" to accept and start working`;

          const msg: InboxMessage = {
            id: newMessageId(),
            from: myId,
            fromName: myName,
            fromRole: myRoleName,
            fromSession: mySession,
            timestamp: new Date().toISOString(),
            message: notification,
          };
          sendToInbox(target.session, target.id, msg);

          const targetAddr = formatAddress(target.session, target.name);
          return {
            content: [{
              type: "text",
              text: `Assigned ${task.id} to ${target.name}. Notification sent to ${targetAddr}.`,
            }],
            details: { task, notifiedAgent: targetAddr },
          };
        }

        // -- pick ---------------------------------------------
        case "pick": {
          if (!myId || !myName) throw new Error("Not registered. Use /pmux join first.");

          const tasks = await readBacklog(mySession);
          let task: Task | undefined;

          if (params.id) {
            task = tasks.find((t) => t.id === params.id);
            if (!task) throw new Error(`Task ${params.id} not found.`);

            if (task.status === "assigned" && task.assigneeId !== myId) {
              throw new Error(
                `${params.id} is assigned to ${task.assignee}, waiting for their response.`
              );
            }
            if (task.status === "in-progress") {
              throw new Error(
                `${params.id} is already in progress${task.assignee ? ` by ${task.assignee}` : ""}.`
              );
            }
            if (task.status === "done") {
              throw new Error(`${params.id} is already done.`);
            }
          } else {
            // Auto-pick: first "todo" task (skip "assigned"  -- those are spoken for)
            task = tasks.find((t) => t.status === "todo");
            if (!task) {
              throw new Error(
                "No tasks available to pick. All tasks are assigned, in progress, blocked, or done."
              );
            }
          }

          // Claim the task
          task.status = "in-progress";
          task.assignee = myName;
          task.assigneeId = myId;
          task.blockedReason = undefined;
          task.updatedAt = new Date().toISOString();
          await writeBacklog(mySession, tasks);

          // Auto-reserve files (partial success  -- Option B)
          const reserved: string[] = [];
          const conflicts: Array<{ path: string; detail: string }> = [];

          if (task.files?.length) {
            const online = await getOnlineAgents(mySession).catch(() => [] as AgentInfo[]);
            const onlineIds = online.map((a) => a.id);
            const reserveReason = `${task.id}: ${task.title}`;

            for (const file of task.files) {
              try {
                await reserve(mySession, [file], myId, myName, reserveReason, onlineIds);
                reserved.push(file);
              } catch (err) {
                conflicts.push({
                  path: file,
                  detail: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }

          // Build response
          let text = `✓ Picked ${task.id}: ${task.title}`;
          if (params.reason) text += `\n  Approach: ${params.reason}`;
          if (reserved.length > 0) text += `\n  Reserved: ${reserved.join(", ")}`;
          if (conflicts.length > 0) {
            for (const c of conflicts) {
              text += `\n  ⚠️ Could not reserve: ${c.path}  -- ${c.detail}`;
            }
            text += `\n  → Consider coordinating via pmux_send.`;
          }

          return {
            content: [{ type: "text", text }],
            details: { task, reserved, conflicts },
          };
        }

        // -- done ---------------------------------------------
        case "done": {
          if (!myId) throw new Error("Not registered. Use /pmux join first.");
          if (!params.id) throw new Error("Task ID is required for done.");

          const tasks = await readBacklog(mySession);
          const task = tasks.find((t) => t.id === params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);
          if (task.status === "done") throw new Error(`${params.id} is already done.`);

          if (task.assigneeId && task.assigneeId !== myId) {
            throw new Error(
              `${params.id} is assigned to ${task.assignee}. Only the assignee can mark it done.`
            );
          }

          task.status = "done";
          task.completedAt = new Date().toISOString();
          task.updatedAt = new Date().toISOString();
          if (params.summary) task.summary = params.summary;
          await writeBacklog(mySession, tasks);

          // Auto-release file reservations
          let released: string[] = [];
          if (task.files?.length) {
            released = await release(mySession, task.files, myId);
          }

          let text = `✓ Completed ${task.id}: ${task.title}`;
          if (params.summary) text += `\n  Summary: ${params.summary}`;
          if (released.length > 0) text += `\n  Released: ${released.join(", ")}`;

          return {
            content: [{ type: "text", text }],
            details: { task, released },
          };
        }

        // -- drop ---------------------------------------------
        case "drop": {
          if (!myId) throw new Error("Not registered. Use /pmux join first.");
          if (!params.id) throw new Error("Task ID is required for drop.");

          const tasks = await readBacklog(mySession);
          const task = tasks.find((t) => t.id === params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);
          if (task.status === "done") throw new Error(`${params.id} is already done.`);
          if (task.status === "todo") throw new Error(`${params.id} is not assigned to anyone.`);

          if (task.assigneeId && task.assigneeId !== myId) {
            throw new Error(
              `${params.id} is assigned to ${task.assignee}. Only the assignee can drop it.`
            );
          }

          task.status = "todo";
          task.assignee = undefined;
          task.assigneeId = undefined;
          task.blockedReason = undefined;
          task.updatedAt = new Date().toISOString();
          await writeBacklog(mySession, tasks);

          // Auto-release file reservations
          let released: string[] = [];
          if (task.files?.length) {
            released = await release(mySession, task.files, myId);
          }

          let text = `✓ Dropped ${task.id}: ${task.title}  -- back in queue`;
          if (released.length > 0) text += `\n  Released: ${released.join(", ")}`;

          return {
            content: [{ type: "text", text }],
            details: { task, released },
          };
        }

        // -- block --------------------------------------------
        case "block": {
          if (!myId) throw new Error("Not registered. Use /pmux join first.");
          if (!params.id) throw new Error("Task ID is required for block.");
          if (!params.reason) throw new Error("Reason is required for block.");

          const tasks = await readBacklog(mySession);
          const task = tasks.find((t) => t.id === params.id);
          if (!task) throw new Error(`Task ${params.id} not found.`);
          if (task.status === "done") throw new Error(`${params.id} is already done.`);

          task.status = "blocked";
          task.blockedReason = params.reason;
          task.updatedAt = new Date().toISOString();
          await writeBacklog(mySession, tasks);

          return {
            content: [{ type: "text", text: `⚠️ ${task.id} blocked: ${params.reason}` }],
            details: { task },
          };
        }

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // - pmux_journal --------------------------------------------

  pi.registerTool({
    name: "pmux_journal",
    label: "Journal",
    description:
      "Append-only journal for recording decisions, learnings, and progress. " +
      "Actions: add (record an entry), list (show recent entries). " +
      "Recent entries are automatically injected into the system prompt.",
    promptSnippet: "Record and review decisions, learnings, and progress",
    promptGuidelines: [
      "Use pmux_journal to record important decisions, things you've learned, and progress updates.",
      "Journal entries are shared across all agents and persist across sessions.",
      "Recent entries are automatically included in the system prompt for context.",
      "When you discover ways to improve team alignment, code quality, or ways of working, capture them as a 'learning'  -- these shape how the team collaborates and raises the quality bar.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "list"] as const),
      type: Type.Optional(
        StringEnum(["decision", "learning", "progress"] as const)
      ),
      content: Type.Optional(
        Type.String({ description: "Journal entry content (required for add)" })
      ),
      context: Type.Optional(
        Type.String({ description: "Optional context (e.g., task ID, topic)" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Number of entries to show (default 20, for list)" })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("pmux session not active");

      switch (params.action) {
        case "add": {
          if (!myId || !myName) throw new Error("Not registered. Use /pmux join first.");
          if (!params.type) throw new Error("Entry type is required for add (decision, learning, or progress).");
          if (!params.content) throw new Error("Content is required for add.");

          const entry = {
            timestamp: new Date().toISOString(),
            agent: myName,
            agentId: myId,
            type: params.type,
            content: params.content,
            context: params.context,
          };
          addJournalEntry(mySession, entry);

          return {
            content: [{
              type: "text",
              text: `✓ Journal entry added: ${formatJournalEntry(entry)}`,
            }],
            details: { entry },
          };
        }

        case "list": {
          const limit = params.limit ?? 20;
          const entries = readJournalEntries(mySession, limit, params.type);

          if (entries.length === 0) {
            const typeNote = params.type ? ` of type "${params.type}"` : "";
            return {
              content: [{ type: "text", text: `No journal entries found${typeNote}.` }],
              details: { entries: [] },
            };
          }

          const lines = entries.map((e) => `  ${formatJournalEntry(e)}`);
          const typeNote = params.type ? ` (${params.type})` : "";
          return {
            content: [{
              type: "text",
              text: `Journal${typeNote} (${entries.length} entries):\n\n${lines.join("\n")}`,
            }],
            details: { entries },
          };
        }

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // -- Commands -------------------------------------------------

  // -- /pmux -- unified command with subcommands -----------------

  pi.registerCommand("pmux", {
    description: "pmux: join, leave, manage, status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "";

      switch (sub) {
        case "":
          return handleStatus(ctx);
        case "join":
          return handleJoin(parts.slice(1).join(" "), ctx);
        case "leave":
          return handleLeave(ctx);
        case "manage":
          return handleManage(ctx);
        case "workspace":
          return handleWorkspace(ctx);
        default:
          ctx.ui.notify(
            `Unknown: /pmux ${sub}\n\nAvailable:\n  /pmux join       Join or create a project\n  /pmux leave   Leave current project\n  /pmux manage     Manage projects and agents\n  /pmux workspace  Git workspace setup and sync`,
            "warning"
          );
      }
    },
  });

  // -- status handler --

  async function handleStatus(ctx: ExtensionContext): Promise<void> {
    if (!mySession || !myId) {
      ctx.ui.notify(
        "Not in a project.\n\n  /pmux join       Join or create a project",
        "info"
      );
      return;
    }

    const agents = await getOnlineAgents(mySession);
    const agentLines = agents.map((a) => {
      const isMe = a.id === myId;
      const marker = isMe ? " <-" : "";
      const roleLabel = a.roleName ?? a.role;
      return `  ${a.name} (${roleLabel})${marker}`;
    });

    ctx.ui.notify(
      `Project: ${mySession} | Agent: ${myName} (${myRoleName || "no role"})\n\nOnline:\n${agentLines.join("\n")}\n\n  /pmux join    Switch project or agent\n  /pmux leave   Leave project\n  /pmux manage     Manage projects and agents\n  /pmux workspace  Git workspace setup and sync`,
      "info"
    );
  }

  // -- join handler --

  async function handleJoin(projectArg: string, ctx: ExtensionContext): Promise<void> {
    // 1. Select or create project
    let project = projectArg.trim();

    if (!project) {
      const sessionsDir = join(homedir(), ".pmux", "sessions");
      let existing: string[] = [];
      try {
        existing = readdirSync(sessionsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {}

      const CREATE_PROJECT = "+ Create new project";
      if (existing.length > 0) {
        const choice = await ctx.ui.select("Join project:", [...existing, CREATE_PROJECT]);
        if (!choice) { ctx.ui.notify("Cancelled.", "info"); return; }
        project = choice === CREATE_PROJECT
          ? (await ctx.ui.input("Project name:")) ?? ""
          : choice;
      } else {
        project = (await ctx.ui.input("Project name:")) ?? "";
      }
      if (!project) { ctx.ui.notify("Cancelled.", "info"); return; }
    }

    // If switching agents (same or different project), go offline first
    const previousAgentId = myId;
    if (myId && mySession) {
      await goOffline(mySession, myId);
      stopAgent();
    }

    mySession = project;

    // Ensure project directory + config exist
    const config = await readSessionConfig(mySession);
    if (!config.createdAt) {
      config.createdAt = new Date().toISOString();
      await writeSessionConfig(mySession, config);
    }

    // 2. Agent selection
    const registry = await readRegistry(mySession);
    const allAgents = Object.values(registry);
    const onlineAgents = allAgents.filter((a) => a.status === "online");
    const offlineAgents = allAgents.filter((a) => a.status === "offline" && a.id !== previousAgentId);

    const CREATE_AGENT = "+ Create new agent";
    let agentChoice: string | undefined;

    if (offlineAgents.length > 0) {
      const options = offlineAgents.map((a) => {
        const roleLabel = a.roleName ? ` (${a.roleName})` : "";
        return `${a.name}${roleLabel}`;
      });
      agentChoice = await ctx.ui.select("Join as:", [...options, CREATE_AGENT]);
      if (!agentChoice) { ctx.ui.notify("Cancelled.", "info"); return; }

    } else if (onlineAgents.length > 0) {
      const names = onlineAgents.map((a) => a.name).join(", ");
      agentChoice = await ctx.ui.select(
        `${onlineAgents.length} agent(s) online (${names}), none available:`,
        [CREATE_AGENT]
      );
      if (!agentChoice) { ctx.ui.notify("Cancelled.", "info"); return; }

    } else {
      agentChoice = await ctx.ui.select(
        `No agents in "${project}" yet:`,
        [CREATE_AGENT]
      );
      if (!agentChoice) { ctx.ui.notify("Cancelled.", "info"); return; }
    }

    if (agentChoice === CREATE_AGENT) {
      // -- Create new agent --
      const name = await ctx.ui.input("Agent name:");
      if (!name) { ctx.ui.notify("Cancelled.", "info"); return; }

      // Role selection: project roles + built-in templates + create new
      const projectRoles = await readRoles(mySession);
      const CREATE_ROLE = "+ Create new role";

      // Merge: project roles first, then built-ins (skip duplicates)
      const allRoles: RoleDefinition[] = [
        ...Object.values(projectRoles),
        ...BUILTIN_ROLES.filter((r) => !projectRoles[r.name]),
      ];

      const roleOptions = [
        ...allRoles.map((r) => {
          const desc = r.description || r.instructions.slice(0, 60);
          return `${r.name} -- ${desc}`;
        }),
        CREATE_ROLE,
      ];

      let roleName: string | undefined;
      let roleInstructions: string | undefined;

      const roleChoice = await ctx.ui.select("Role:", roleOptions);
      if (roleChoice && roleChoice !== CREATE_ROLE) {
        const selectedRoleName = roleChoice.split(" -- ")[0]!;
        const role = allRoles.find((r) => r.name === selectedRoleName);
        if (role) {
          roleName = role.name;
          roleInstructions = role.instructions;
          // If built-in, copy to project roles for customization
          if (!projectRoles[role.name]) {
            await addRole(mySession, role);
          }
        }
      } else if (roleChoice === CREATE_ROLE) {
        const newName = await ctx.ui.input("Role name:");
        if (!newName) { ctx.ui.notify("Cancelled.", "info"); return; }
        const newDesc = await ctx.ui.input("Short description:");
        if (!newDesc) { ctx.ui.notify("Cancelled.", "info"); return; }
        const newInstr = await ctx.ui.input("Full instructions:");
        if (!newInstr) { ctx.ui.notify("Cancelled.", "info"); return; }

        const newRole: RoleDefinition = { name: newName, description: newDesc, instructions: newInstr };
        await addRole(mySession, newRole);
        roleName = newName;
        roleInstructions = newInstr;
      }

      myId = newAgentId();
      myName = name;
      myRoleName = roleName;
      myRole = roleName ?? `Agent ${name}`;
      myRoleInstructions = roleInstructions;

      const agent: AgentInfo = {
        id: myId,
        name: myName,
        session: mySession,
        role: myRole,
        roleName: myRoleName,
        cwd: ctx.cwd,
        pid: process.pid,
        status: "online",
        registeredAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      };
      await registerAgent(mySession, agent);
      await startAgent(ctx);

      const roleNote = roleName ? ` with role "${roleName}"` : "";
      ctx.ui.notify(`Joined "${project}" as "${name}"${roleNote}.`, "info");

    } else {
      // -- Resume existing agent --
      const selectedName = agentChoice.split(" (")[0]!;
      const agent = offlineAgents.find((a) => a.name === selectedName);
      if (!agent) { ctx.ui.notify("Agent not found.", "error"); return; }

      myId = agent.id;
      myName = agent.name;
      myRole = agent.role;
      myRoleName = agent.roleName;
      if (agent.roleName) {
        await loadRoleInstructions(mySession, agent.roleName);
      }

      await updateAgent(mySession, myId, { cwd: ctx.cwd });
      await startAgent(ctx);

      const pending = getRecoverableMessages(mySession, myId);
      const pendingNote = pending.length > 0 ? ` ${pending.length} message(s) waiting.` : "";
      ctx.ui.notify(
        `Joined "${project}" as "${myName}" (${myRoleName || "no role"}).${pendingNote}`,
        "info"
      );
    }
  }

  // -- leave handler --

  async function handleLeave(ctx: ExtensionContext): Promise<void> {
    if (!mySession || !myId) {
      ctx.ui.notify("Not in any project.", "info");
      return;
    }

    const projectName = mySession;

    await goOffline(mySession, myId);
    stopAgent();
    pi.appendEntry("pmux-agent", { id: null, session: null });

    myId = undefined;
    myName = undefined;
    myRole = undefined;
    myRoleName = undefined;
    myRoleInstructions = undefined;
    mySession = undefined;

    ctx.ui.setStatus("pmux", "");
    ctx.ui.setTitle("pi");

    ctx.ui.notify(`Left project "${projectName}". Back to solo Pi.`, "info");
  }

  // -- manage handler --

  async function handleManage(ctx: ExtensionContext): Promise<void> {
    const what = await ctx.ui.select("Manage:", ["Projects", "Agents", "Roles"]);
    if (!what) return;

    if (what === "Projects") {
      await manageProjects(ctx);
    } else if (what === "Agents") {
      await manageAgents(ctx);
    } else {
      await manageRoles(ctx);
    }
  }

  async function manageProjects(ctx: ExtensionContext): Promise<void> {
    const sessionsDir = join(homedir(), ".pmux", "sessions");
    let projects: string[] = [];
    try {
      projects = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {}

    if (projects.length === 0) {
      ctx.ui.notify("No projects found.", "info");
      return;
    }

    const project = await ctx.ui.select("Select project:", projects);
    if (!project) return;

    const action = await ctx.ui.select(`Project "${project}":`, ["Rename", "Delete"]);
    if (!action) return;

    // Check for online agents
    const agents = await getOnlineAgents(project);
    if (agents.length > 0) {
      const names = agents.map((a) => a.name).join(", ");
      ctx.ui.notify(
        `Cannot ${action.toLowerCase()} "${project}": ${agents.length} agent(s) online (${names}).\nThey must /pmux leave first.`,
        "warning"
      );
      return;
    }

    if (action === "Delete") {
      const confirm = await ctx.ui.confirm("Delete project?", `Permanently delete "${project}" and all its data?`);
      if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }

      const { rmSync } = await import("node:fs");
      rmSync(join(sessionsDir, project), { recursive: true, force: true });
      ctx.ui.notify(`Deleted project "${project}".`, "info");

    } else if (action === "Rename") {
      const newName = await ctx.ui.input("New name:", project);
      if (!newName || newName === project) { ctx.ui.notify("Cancelled.", "info"); return; }

      const { renameSync, readFileSync: readF, writeFileSync: writeF } = await import("node:fs");
      renameSync(join(sessionsDir, project), join(sessionsDir, newName));

      // Update session field in all agent records
      try {
        const agentsPath = join(sessionsDir, newName, "agents.json");
        const agents = JSON.parse(readF(agentsPath, "utf8"));
        for (const agent of Object.values(agents) as AgentInfo[]) {
          agent.session = newName;
        }
        writeF(agentsPath, JSON.stringify(agents, null, 2), "utf8");
      } catch {}

      ctx.ui.notify(`Renamed "${project}" to "${newName}".`, "info");
    }
  }

  async function manageAgents(ctx: ExtensionContext): Promise<void> {
    if (!mySession) {
      ctx.ui.notify("Join a project first with /pmux join.", "info");
      return;
    }

    const registry = await readRegistry(mySession);
    const allAgents = Object.values(registry);
    const offlineAgents = allAgents.filter((a) => a.status === "offline");

    if (offlineAgents.length === 0) {
      ctx.ui.notify("No offline agents to manage. Online agents must /pmux leave first.", "info");
      return;
    }

    const options = offlineAgents.map((a) => {
      const roleLabel = a.roleName ? ` (${a.roleName})` : "";
      return `${a.name}${roleLabel}`;
    });
    const selected = await ctx.ui.select("Select agent:", options);
    if (!selected) return;

    const selectedName = selected.split(" (")[0]!;
    const agent = offlineAgents.find((a) => a.name === selectedName);
    if (!agent) return;

    const action = await ctx.ui.select(`Agent "${agent.name}":`, ["Rename", "Delete"]);
    if (!action) return;

    if (action === "Delete") {
      const confirm = await ctx.ui.confirm("Delete agent?", `Permanently delete "${agent.name}"?`);
      if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }

      await removeAgent(mySession, agent.id);
      ctx.ui.notify(`Deleted agent "${agent.name}".`, "info");

    } else if (action === "Rename") {
      const newName = await ctx.ui.input("New name:", agent.name);
      if (!newName || newName === agent.name) { ctx.ui.notify("Cancelled.", "info"); return; }

      await updateAgent(mySession, agent.id, { name: newName });
      ctx.ui.notify(`Renamed "${agent.name}" to "${newName}".`, "info");
    }
  }



  async function manageRoles(ctx: ExtensionContext): Promise<void> {
    if (!mySession) {
      ctx.ui.notify("Join a project first with /pmux join.", "info");
      return;
    }

    const roles = await readRoles(mySession);
    const roleNames = Object.keys(roles);

    const ADD_NEW = "+ Add new role";
    const options = [
      ...roleNames.map((name) => {
        const desc = roles[name]!.description || roles[name]!.instructions.slice(0, 60);
        return `${name} -- ${desc}`;
      }),
      ADD_NEW,
    ];

    const choice = await ctx.ui.select("Roles:", options);
    if (!choice) return;

    if (choice === ADD_NEW) {
      const name = await ctx.ui.input("Role name:");
      if (!name) { ctx.ui.notify("Cancelled.", "info"); return; }
      const desc = await ctx.ui.input("Short description:");
      if (!desc) { ctx.ui.notify("Cancelled.", "info"); return; }
      const instructions = await ctx.ui.input("Full instructions:");
      if (!instructions) { ctx.ui.notify("Cancelled.", "info"); return; }

      await addRole(mySession, { name, description: desc, instructions });
      ctx.ui.notify(`Role "${name}" added.`, "info");

    } else {
      // Selected an existing role
      const selectedName = choice.split(" -- ")[0]!;
      const action = await ctx.ui.select(`Role "${selectedName}":`, ["Delete"]);
      if (!action) return;

      if (action === "Delete") {
        const confirm = await ctx.ui.confirm("Delete role?", `Permanently delete role "${selectedName}"?`);
        if (!confirm) { ctx.ui.notify("Cancelled.", "info"); return; }

        await removeRole(mySession, selectedName);
        ctx.ui.notify(`Role "${selectedName}" deleted.`, "info");
      }
    }
  }



  // -- workspace handler --

  async function handleWorkspace(ctx: ExtensionContext): Promise<void> {
    const action = await ctx.ui.select("Workspace:", ["setup", "create", "sync", "status"]);
    if (!action) return;

    switch (action) {
      case "setup": {
        if (!mySession || !myId) { ctx.ui.notify("Join a project first with /pmux join.", "warning"); return; }

        // Check if cwd is a git repo
        const gitCheck = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
        if (gitCheck.code !== 0) {
          ctx.ui.notify("Current directory is not a git repository.", "warning");
          return;
        }

        const repoPath = gitCheck.stdout.trim();

        // Set main repo in project config
        const config = await readSessionConfig(mySession);
        config.mainRepo = repoPath;
        await writeSessionConfig(mySession, config);

        // Set current agent's workspace to cwd
        await updateAgent(mySession, myId, { workspace: ctx.cwd });

        const branchResult = await pi.exec("git", ["branch", "--show-current"], { timeout: 5000 });
        const branch = branchResult.stdout.trim() || "main";

        ctx.ui.notify(`Main repo set to: ${repoPath}\nYour workspace: ${ctx.cwd}\nBranch: ${branch}`, "info");
        break;
      }

      case "create": {
        if (!mySession || !myId) {
          ctx.ui.notify("Join a project first with /pmux join.", "warning");
          return;
        }

        const config = await readSessionConfig(mySession);
        if (!config.mainRepo) {
          ctx.ui.notify("No main repo configured. Run /pmux workspace > setup first.", "warning");
          return;
        }

        // Select which agent to create workspace for
        const registry = await readRegistry(mySession);
        const agents = Object.values(registry).filter((a) => !a.workspace && a.id !== myId);

        if (agents.length === 0) {
          ctx.ui.notify("All agents already have workspaces (or no other agents in project).", "info");
          return;
        }

        const agentOptions = agents.map((a) => {
          const roleLabel = a.roleName ? ` (${a.roleName})` : "";
          return `${a.name}${roleLabel}`;
        });
        const agentChoice = await ctx.ui.select("Create workspace for:", agentOptions);
        if (!agentChoice) { ctx.ui.notify("Cancelled.", "info"); return; }

        const targetName = agentChoice.split(" (")[0]!;
        const targetAgent = agents.find((a) => a.name === targetName);
        if (!targetAgent) { ctx.ui.notify("Agent not found.", "error"); return; }

        // Default worktree path: sibling of main repo
        const { basename: bn, dirname: dn } = await import("node:path");
        const repoName = bn(config.mainRepo);
        const parentDir = dn(config.mainRepo);
        const defaultPath = `${parentDir}/${repoName}-${targetName}`;

        const worktreePath = await ctx.ui.input("Worktree path:", defaultPath);
        if (!worktreePath) { ctx.ui.notify("Cancelled.", "info"); return; }

        const branchName = `agent/${targetName}`;

        // Create worktree
        const result = await pi.exec(
          "git",
          ["-C", config.mainRepo, "worktree", "add", worktreePath, "-b", branchName],
          { timeout: 30000 }
        );

        if (result.code !== 0) {
          const retry = await pi.exec(
            "git",
            ["-C", config.mainRepo, "worktree", "add", worktreePath, branchName],
            { timeout: 30000 }
          );
          if (retry.code !== 0) {
            ctx.ui.notify(`Failed to create worktree: ${retry.stderr}`, "error");
            return;
          }
        }

        // Store workspace path in target agent's record
        await updateAgent(mySession, targetAgent.id, { workspace: worktreePath });

        ctx.ui.notify(
          `Workspace created for ${targetName}:\n  Path: ${worktreePath}\n  Branch: ${branchName}\n\n${targetName} can start Pi there and /pmux join.`,
          "info"
        );
        break;
      }

      case "sync": {
        if (!mySession || !myId) {
          ctx.ui.notify("Join a project first.", "warning");
          return;
        }

        const agent = await findById(mySession, myId);
        const workDir = agent?.workspace || ctx.cwd;

        const config = await readSessionConfig(mySession);
        if (!config.mainRepo) {
          ctx.ui.notify("No main repo configured.", "warning");
          return;
        }

        // Get main branch name
        const mainBranch = await pi.exec(
          "git", ["-C", config.mainRepo, "branch", "--show-current"],
          { timeout: 5000 }
        );
        const mainBranchName = mainBranch.stdout.trim() || "main";

        // Fetch and rebase
        const fetch = await pi.exec("git", ["-C", workDir, "fetch", "origin"], { timeout: 30000 });
        const rebase = await pi.exec("git", ["-C", workDir, "rebase", mainBranchName], { timeout: 30000 });

        if (rebase.code !== 0) {
          ctx.ui.notify(`Rebase conflicts:\n${rebase.stderr}\n\nResolve conflicts, then: git rebase --continue`, "warning");
        } else {
          ctx.ui.notify(`Synced with ${mainBranchName}. Up to date.`, "info");
        }
        break;
      }

      case "status": {
        if (!mySession || !myId) {
          ctx.ui.notify("Join a project first.", "warning");
          return;
        }

        const agent = await findById(mySession, myId);
        const workDir = agent?.workspace || ctx.cwd;

        const branch = await pi.exec("git", ["-C", workDir, "branch", "--show-current"], { timeout: 5000 });
        const status = await pi.exec("git", ["-C", workDir, "status", "--short"], { timeout: 5000 });

        const config = await readSessionConfig(mySession);
        const mainBranchName = config.mainRepo
          ? (await pi.exec("git", ["-C", config.mainRepo, "branch", "--show-current"], { timeout: 5000 })).stdout.trim() || "main"
          : "main";

        const ahead = await pi.exec(
          "git", ["-C", workDir, "rev-list", "--count", `${mainBranchName}..HEAD`],
          { timeout: 5000 }
        );
        const behind = await pi.exec(
          "git", ["-C", workDir, "rev-list", "--count", `HEAD..${mainBranchName}`],
          { timeout: 5000 }
        );

        const dirtyFiles = status.stdout.trim();
        const dirtyCount = dirtyFiles ? dirtyFiles.split("\n").length : 0;

        let info = `Branch: ${branch.stdout.trim()}`;
        info += `\nWorktree: ${workDir}`;
        info += `\nAhead of ${mainBranchName}: ${ahead.stdout.trim()} commits`;
        info += `\nBehind ${mainBranchName}: ${behind.stdout.trim()} commits`;
        info += `\nDirty files: ${dirtyCount}`;

        if (dirtyFiles) {
          info += `\n\n${dirtyFiles}`;
        }

        ctx.ui.notify(info, "info");
        break;
      }
    }
  }

  // -- Helpers --------------------------------------------------

  /** Format a duration in milliseconds to a human-readable string. */
  function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }

  // -- Artifacts ------------------------------------------------

  const PMUX_BASE = join(homedir(), ".pmux", "sessions");

  function projectArtifactsDir(): string {
    return join(PMUX_BASE, mySession!, "artifacts", "project");
  }


  function agentArtifactsDir(agentId: string): string {
    return join(PMUX_BASE, mySession!, "artifacts", "agents", agentId);
  }

  function ensureArtifactDirs(): void {
    if (!mySession || !myId) return;
    mkdirSync(projectArtifactsDir(), { recursive: true });
    mkdirSync(agentArtifactsDir(myId), { recursive: true });
  }

  function listFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter((f) => !f.startsWith("."));
    } catch {
      return [];
    }
  }

  const MAX_CONTEXT_SIZE = 4096;

  /** Read a CONTEXT.md file if it exists, with size guard. */
  function readContextFile(dir: string): string | null {
    const path = join(dir, "CONTEXT.md");
    if (!existsSync(path)) return null;
    try {
      let content = readFileSync(path, "utf8").trim();
      if (content.length > MAX_CONTEXT_SIZE) {
        content = content.slice(0, MAX_CONTEXT_SIZE) + `\n\n[truncated  -- see full file at ${path}]`;
      }
      return content || null;
    } catch {
      return null;
    }
  }

  async function applyDefaultModel(ctx: ExtensionContext): Promise<void> {
    const modelStr = process.env.PMUX_MODEL;
    if (!modelStr) {
      if (mySession) {
        const config = await readSessionConfig(mySession);
        if (config.model) await trySetModel(ctx, config.model);
      }
      return;
    }
    await trySetModel(ctx, modelStr);
  }

  async function trySetModel(ctx: ExtensionContext, modelStr: string): Promise<void> {
    let found = false;

    if (modelStr.includes("/")) {
      const [provider, id] = modelStr.split("/", 2);
      const model = ctx.modelRegistry.find(provider!, id!);
      if (model) found = !!(await pi.setModel(model));
    }

    if (!found) {
      for (const provider of ["anthropic", "openai", "google", "local-openai"]) {
        const model = ctx.modelRegistry.find(provider, modelStr);
        if (model) {
          found = !!(await pi.setModel(model));
          if (found) break;
        }
      }
    }

    if (!found) {
      ctx.ui.notify(`pmux: model "${modelStr}" not found  -- using default`, "warning");
    }
  }

  async function refreshStatusWidget(ctx: ExtensionContext): Promise<void> {
    if (!mySession) return;

    try {
      const agents = await getOnlineAgents(mySession);
      const theme = ctx.ui.theme;
      const sessionLabel = theme.fg("dim", `[${mySession}] `);

      if (agents.length === 0) {
        ctx.ui.setStatus("pmux", sessionLabel + theme.fg("dim", "no agents"));
        return;
      }

      const parts = agents.map((a) => {
        const icon = a.id === myId ? "◆" : "○";
        const color: "accent" | "success" = a.id === myId ? "accent" : "success";
        const label = [a.roleName, a.name].filter(Boolean).join(":");
        return theme.fg(color, `${icon} ${label}`);
      });

      ctx.ui.setStatus("pmux", sessionLabel + parts.join(theme.fg("dim", " | ")));
    } catch {
      // Ignore widget errors
    }
  }
}
