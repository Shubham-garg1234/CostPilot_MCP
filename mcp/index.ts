const apiUrl = normalizeApiBaseUrl(process.env.COSTPILOT_API_URL?.trim() || "http://127.0.0.1:4000");
const employeeEmail = process.env.COSTPILOT_EMPLOYEE_EMAIL?.trim();
const employeePassword = process.env.COSTPILOT_EMPLOYEE_PASSWORD?.trim();

type JsonRpcId = number | string | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

let employeeToken = "";
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

function processBuffer() {
  while (true) {
    const separatorIndex = buffer.indexOf("\r\n\r\n");
    if (separatorIndex === -1) {
      return;
    }

    const headerText = buffer.subarray(0, separatorIndex).toString("utf8");
    const contentLengthHeader = headerText
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-length:"));

    if (!contentLengthHeader) {
      buffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number(contentLengthHeader.split(":")[1]?.trim() ?? 0);
    const messageStart = separatorIndex + 4;
    const totalLength = messageStart + contentLength;

    if (buffer.length < totalLength) {
      return;
    }

    const payload = buffer.subarray(messageStart, totalLength).toString("utf8");
    buffer = buffer.subarray(totalLength);

    try {
      void handleMessage(JSON.parse(payload) as JsonRpcRequest);
    } catch {
      writeError(null, -32700, "Invalid JSON");
    }
  }
}

async function handleMessage(message: JsonRpcRequest) {
  switch (message.method) {
    case "initialize":
      return writeResult(message.id ?? null, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "costpilot-mcp",
          version: "0.1.0"
        }
      });
    case "notifications/initialized":
      return;
    case "tools/list":
      return writeResult(message.id ?? null, {
        tools: [
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
                promptTokens: { type: "number" },
                completionTokens: { type: "number" },
                totalTokens: { type: "number" },
                costUsd: { type: "number" },
                metadata: { type: "object" }
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
        ]
      });
    case "tools/call":
      return handleToolCall(message);
    default:
      return writeError(message.id ?? null, -32601, `Method not found: ${message.method}`);
  }
}

async function handleToolCall(message: JsonRpcRequest) {
  const name = String(message.params?.name ?? "");
  const args = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};

  try {
    switch (name) {
      case "track_usage_event": {
        const result = await apiFetch("/api/usage-events", {
          method: "POST",
          body: JSON.stringify(args)
        });
        return writeToolResult(message.id ?? null, result);
      }
      case "get_usage_summary": {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(args)) {
          if (value !== undefined && value !== null && value !== "") {
            query.set(key, String(value));
          }
        }
        const suffix = query.size > 0 ? `?${query.toString()}` : "";
        const result = await apiFetch(`/api/usage-events/summary${suffix}`);
        return writeToolResult(message.id ?? null, result);
      }
      case "get_budget_status": {
        const result = await apiFetch("/api/dashboard/summary");
        return writeToolResult(message.id ?? null, result);
      }
      case "list_policies": {
        const result = await apiFetch("/api/policies");
        return writeToolResult(message.id ?? null, result);
      }
      case "enhance_prompt": {
        const result = await apiFetch("/api/prompt-enhancement", {
          method: "POST",
          body: JSON.stringify(args)
        });
        return writeToolResult(message.id ?? null, result);
      }
      default:
        return writeError(message.id ?? null, -32602, `Unknown tool: ${name}`);
    }
  } catch (error) {
    return writeError(message.id ?? null, -32000, error instanceof Error ? error.message : "Tool call failed");
  }
}

async function apiFetch(requestPath: string, init: RequestInit = {}) {
  if (!employeeToken) {
    employeeToken = await loginEmployee();
  }

  const requestUrl = buildApiUrl(requestPath);
  const response = await fetch(requestUrl, {
    ...init,
    headers: {
      Authorization: `Bearer ${employeeToken}`,
      "Content-Type": "application/json",
      ...((init.headers ?? {}) as Record<string, string>)
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
          ? String((payload as { message?: string }).message)
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

  const payload = (await response.json().catch(() => null)) as { token?: string; message?: string } | null;
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.message ?? "Unable to log in MCP employee session.");
  }

  return payload.token;
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeApiBaseUrl(url: string) {
  const trimmed = (url || "").trim();
  const fallback = "http://127.0.0.1:4000";
  const candidate = trimmed || fallback;

  let normalized: URL;
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

function buildApiUrl(requestPath: string) {
  const path = String(requestPath || "");
  const safePath = path.startsWith("/") ? path : `/${path}`;
  return new URL(safePath, `${apiUrl}/`).toString();
}

function writeToolResult(id: JsonRpcId, payload: unknown) {
  writeResult(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  });
}

function writeResult(id: JsonRpcId, result: unknown) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result
  });
}

function writeError(id: JsonRpcId, code: number, message: string) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
}

function writeMessage(message: Record<string, unknown>) {
  const payload = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
}
