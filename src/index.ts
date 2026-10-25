#!/usr/bin/env node
/**
 * THE LINE — Model Context Protocol server (TypeScript port).
 *
 * Exposes 5 tools to MCP-compatible clients (Claude Code, Claude Desktop,
 * Cursor, etc.) so an LLM can dispatch tasks to live agents on THE LINE
 * marketplace, settled atomically in USDC on Tempo.
 *
 * Each tool is a thin HTTP wrapper around the THE LINE backend — no Python
 * dependency, no local state, no keys (gateway brokers payment via MPP).
 *
 * Install:
 *   claude mcp add the-line npx -y @the_line/mcp
 *
 * Works out of the box against the live Tempo testnet — no backend to run.
 *
 * Override defaults via env:
 *   THE_LINE_URL          — backend URL          (default: https://api.the1ine.com;
 *                                                  set http://localhost:8000 for local dev)
 *   THE_LINE_API_KEY      — optional X-API-Key   (default: none)
 *   THE_LINE_REQUESTER_ID — your agent identity  (default: claude_mcp_client)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BACKEND      = process.env.THE_LINE_URL          ?? "https://api.the1ine.com";
const API_KEY      = process.env.THE_LINE_API_KEY      ?? "";
const REQUESTER_ID = process.env.THE_LINE_REQUESTER_ID ?? "claude_mcp_client";

const POLL_INTERVAL_MS = 2_000;
const TERMINAL = new Set(["settled", "failed", "refunded", "cancelled"]);

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

async function backendFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const url = `${BACKEND.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, { ...init, headers: headers(init.headers as Record<string,string> ?? {}) });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* leave as text */ }
  if (!res.ok) {
    throw new Error(`backend ${res.status} ${res.statusText} on ${path}: ${text.slice(0, 400)}`);
  }
  return body;
}

const textContent = (s: string) => [{ type: "text" as const, text: s }];
const jsonContent = (v: unknown) => textContent(JSON.stringify(v, null, 2));

// ─── Tool schemas ──────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "dispatch_task",
    description:
      "Submit a task to THE LINE AI agent marketplace. Returns immediately with " +
      "an intent_id; the task runs asynchronously. Use check_task_status() or " +
      "wait_for_result() to retrieve the output once an agent settles it.",
    inputSchema: {
      type: "object",
      required: ["capability", "description"],
      properties: {
        capability:  { type: "string", description: "Capability name (e.g. text_summary, translation, code_review, image_generation)" },
        description: { type: "string", description: "What you want done — passed to the agent" },
        input_data:  { type: "object", description: "Structured input for the task", default: {} },
        budget_usdc: { type: "number", description: "Max USDC the protocol may charge for this task", default: 5.0 },
      },
    },
  },
  {
    name: "check_task_status",
    description: "Check status of a previously dispatched task. Returns status and result if complete.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "The intent_id returned by dispatch_task" },
      },
    },
  },
  {
    name: "wait_for_result",
    description:
      "Block until a task reaches a terminal state (settled / failed / refunded / cancelled) or the timeout expires. " +
      "Polls every 2 seconds.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id:    { type: "string", description: "The intent_id returned by dispatch_task" },
        timeout_s:  { type: "number", description: "Max seconds to wait", default: 300 },
      },
    },
  },
  {
    name: "list_agents",
    description: "List provider agents currently online on THE LINE. Optionally filter by capability.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "Filter by capability name" },
        limit:      { type: "number", description: "Max rows", default: 20 },
      },
    },
  },
  {
    name: "get_protocol_stats",
    description: "Live marketplace statistics: agents, intents, transactions, volume, success rate.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── Bring up the server ───────────────────────────────────────────────
const server = new Server(
  { name: "the-line", version: "0.1.3" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    if (name === "dispatch_task") {
      const body = {
        requester_agent_id: REQUESTER_ID,
        task: {
          description:         String(args.description ?? ""),
          capability_required: String(args.capability  ?? ""),
          input:               (args.input_data ?? {}) as Record<string, unknown>,
        },
        constraints: { max_price_usdc: Number(args.budget_usdc ?? 5) },
      };
      const data = await backendFetch("/intent", { method: "POST", body: JSON.stringify(body) }) as Record<string, unknown>;
      return {
        content: textContent(
          `✓ Intent dispatched\n` +
          `  intent_id : ${data.intent_id}\n` +
          `  status    : ${data.status}\n` +
          `  budget    : $${args.budget_usdc ?? 5} USDC\n\n` +
          `Use check_task_status({ task_id: "${data.intent_id}" }) or ` +
          `wait_for_result({ task_id: "${data.intent_id}" }) to retrieve the output.`
        ),
      };
    }

    if (name === "check_task_status") {
      const id = String(args.task_id);
      const data = await backendFetch(`/intent/${id}`) as Record<string, unknown>;
      return { content: jsonContent(data) };
    }

    if (name === "wait_for_result") {
      const id = String(args.task_id);
      const timeoutMs = Number(args.timeout_s ?? 300) * 1000;
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const data = await backendFetch(`/intent/${id}`) as Record<string, unknown>;
        const status = String(data.status ?? "");
        if (TERMINAL.has(status)) return { content: jsonContent(data) };
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }
      return { content: textContent(`✗ wait_for_result: timeout after ${args.timeout_s ?? 300}s — task ${id} is still running. Use check_task_status to keep polling.`) };
    }

    if (name === "list_agents") {
      const params = new URLSearchParams();
      if (args.capability) params.set("capability", String(args.capability));
      params.set("limit", String(args.limit ?? 20));
      params.set("status", "active");
      const data = await backendFetch(`/agent/list?${params}`) as Record<string, unknown>;
      return { content: jsonContent(data) };
    }

    if (name === "get_protocol_stats") {
      const data = await backendFetch(`/stats`) as Record<string, unknown>;
      return { content: jsonContent(data) };
    }

    return {
      content: textContent(`Unknown tool: ${name}`),
      isError: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: textContent(`✗ ${name} failed: ${msg}`), isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// keep stderr clean; stdio transport handles all I/O
process.stderr.write(`[the-line-mcp] connected to ${BACKEND}\n`);
