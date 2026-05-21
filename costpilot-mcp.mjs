#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SERVER_INFO = {
  name: "costpilot-mcp",
  version: "0.1.0"
};

const apiUrl = normalizeApiBaseUrl(
  process.env.COSTPILOT_API_URL?.trim() || process.env.NEXT_PUBLIC_API_URL?.trim() || "http://127.0.0.1:4000"
);
const employeeEmail = process.env.COSTPILOT_EMPLOYEE_EMAIL?.trim() || "";
const employeePassword = process.env.COSTPILOT_EMPLOYEE_PASSWORD?.trim() || "";

let employeeToken = "";

const tools = [
  {
    name: "track_usage_event",
    description: "Record token, cost, category, and source metadata in CostPilot.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        provider: { type: "string", enum: ["openai", "anthropic", "gemini"] },
        category: { type: "string" },
        feature: { type: "string" },
        source: { type: "string" },
        integrationType: { type: "string" },
        workspaceId: { type: "string" },
        sessionId: { type: "string" },
        requestId: { type: "string" },
        status: { type: "string" },
        promptTokens: { type: "number" },
        completionTokens: { type: "number" },
        totalTokens: { type: "number" },
        costUsd: { type: "number" },
        metadata: { type: "object" },
        startedAt: { type: "string" },
        completedAt: { type: "string" }
      },
      required: ["model", "provider", "category"]
    }
  },
  {
    name: "get_usage_summary",
    description: "Fetch usage totals and grouped breakdowns from CostPilot.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        category: { type: "string" },
        provider: { type: "string", enum: ["openai", "anthropic", "gemini"] },
        days: { type: "number" }
      }
    }
  },
  {
    name: "get_budget_status",
    description: "Fetch the dashboard summary metrics and source/provider cost splits.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "list_policies",
    description: "List active CostPilot policies for the current organization.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "enhance_prompt",
    description: "Tune a raw Cursor prompt into a clearer, implementation-ready prompt using CostPilot's OpenAI-backed enhancer.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: { type: "string", description: "Optional OpenAI model for prompt enhancement." },
        targetModel: { type: "string", description: "Optional target model or agent that will use the refined prompt." },
        objective: { type: "string", description: "Optional goal the prompt should optimize for." },
        context: { type: "string", description: "Optional project or task context to preserve in the refined prompt." },
        metadata: { type: "object" }
      },
      required: ["prompt"]
    }
  }
];

const server = new Server(
  SERVER_INFO,
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = String(request.params.name ?? "");
  const args = request.params.arguments ?? {};

  try {
    switch (name) {
      case "track_usage_event":
        return createToolResult(
          await apiFetch("/api/usage-events", {
            method: "POST",
            body: JSON.stringify(args)
          })
        );
      case "get_usage_summary": {
        const query = new URLSearchParams();

        for (const [key, value] of Object.entries(args)) {
          if (value !== undefined && value !== null && value !== "") {
            query.set(key, String(value));
          }
        }

        const suffix = query.size > 0 ? `?${query.toString()}` : "";
        return createToolResult(await apiFetch(`/api/usage-events/summary${suffix}`));
      }
      case "get_budget_status":
        return createToolResult(await apiFetch("/api/dashboard/summary"));
      case "list_policies":
        return createToolResult(await apiFetch("/api/policies"));
      case "enhance_prompt":
        return createToolResult(
          await apiFetch("/api/prompt-enhancement", {
            method: "POST",
            body: JSON.stringify(args)
          })
        );
      default:
        return createToolError(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool call failed";
    return createToolError(message);
  }
});

async function apiFetch(requestPath, init = {}) {
  if (!employeeToken) {
    employeeToken = await loginEmployee();
  }

  const requestUrl = buildApiUrl(requestPath);
  const response = await fetch(requestUrl, {
    ...init,
    headers: {
      Authorization: `Bearer ${employeeToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  if (response.status === 401) {
    employeeToken = await loginEmployee();
    return apiFetch(requestPath, init);
  }

  const text = await response.text();
  const payload = text ? safeJsonParse(text) : {};

  if (!response.ok) {
    throw new Error(
      `CostPilot API ${response.status}: ${
        typeof payload === "object" && payload && "message" in payload
          ? String(payload.message)
          : text || "Request failed"
      }`
    );
  }

  return payload;
}

async function loginEmployee() {
  if (!employeeEmail || !employeePassword) {
    throw new Error("Set COSTPILOT_EMPLOYEE_EMAIL and COSTPILOT_EMPLOYEE_PASSWORD before using CostPilot MCP.");
  }

  const response = await fetch(buildApiUrl("/api/auth/employee-login"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email: employeeEmail,
      password: employeePassword
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.message ?? "Unable to log in MCP employee session.");
  }

  return payload.token;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeApiBaseUrl(url) {
  const trimmed = (url || "").trim();
  const fallback = "http://127.0.0.1:4000";
  const candidate = trimmed || fallback;

  let normalized;
  try {
    normalized = new URL(candidate);
  } catch {
    normalized = new URL(fallback);
  }

  // Windows may resolve localhost to IPv6 where local API isn't bound.
  if (normalized.hostname === "localhost") {
    normalized.hostname = "127.0.0.1";
  }

  normalized.pathname = normalized.pathname.replace(/\/+$/, "");
  return normalized.toString().replace(/\/+$/, "");
}

function buildApiUrl(requestPath) {
  const path = String(requestPath || "");
  const safePath = path.startsWith("/") ? path : `/${path}`;
  return new URL(safePath, `${apiUrl}/`).toString();
}

function createToolResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function createToolError(message) {
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    isError: true
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(
    "[costpilot-mcp] Fatal startup error:",
    error instanceof Error ? error.stack ?? error.message : error
  );
  process.exit(1);
});
