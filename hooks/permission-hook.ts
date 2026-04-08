#!/usr/bin/env bun
// Permission hook — called by Claude Code on PermissionRequest.
// Reads the permission JSON from stdin, POSTs to the daemon HTTP server,
// then long-polls for the decision. Exits 0 (allow) or 2 (deny).

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SETTINGS_PATH = join(process.cwd(), ".claude", "claudeclaw", "settings.json");
const DEFAULT_PORT = 4632;

function getPort(): number {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = readFileSync(SETTINGS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      const port = parsed?.web?.port;
      if (typeof port === "number" && port > 0 && port < 65536) return port;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_PORT;
}

async function main() {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    process.exit(2);
  }

  let permRequest: { tool?: { name?: string }; toolUse?: { name?: string; input?: unknown }; [key: string]: unknown };
  try {
    permRequest = JSON.parse(raw);
  } catch {
    process.stderr.write(`[permission-hook] Failed to parse stdin JSON\n`);
    process.exit(2);
  }

  // Extract tool name and input from the PermissionRequest shape Claude Code sends
  // Claude Code sends: { type: "PermissionRequest", tool: { name, input, ... }, ... }
  const toolName =
    (permRequest as any)?.tool?.name ??
    (permRequest as any)?.toolUse?.name ??
    (permRequest as any)?.toolName ??
    "unknown";

  const toolInput =
    (permRequest as any)?.tool?.input ??
    (permRequest as any)?.toolUse?.input ??
    (permRequest as any)?.toolInput ??
    {};

  const port = getPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  // POST to register the permission
  let id: string;
  try {
    const res = await fetch(`${baseUrl}/api/permission/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName, toolInput }),
    });
    if (!res.ok) {
      process.stderr.write(`[permission-hook] Server responded ${res.status}\n`);
      process.exit(2);
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) {
      process.stderr.write(`[permission-hook] No id in response\n`);
      process.exit(2);
    }
    id = body.id;
  } catch (err) {
    process.stderr.write(`[permission-hook] Failed to reach daemon: ${err}\n`);
    // Daemon not running — deny to be safe
    process.exit(2);
  }

  // Long-poll until we get a decision
  const deadline = Date.now() + 6 * 60 * 1000; // 6 min (slightly longer than server timeout)
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/permission/poll/${id}`);
      if (res.ok) {
        const body = (await res.json()) as { decision?: string; pending?: boolean };
        if (body.decision === "allow") {
          process.exit(0);
        } else if (body.decision === "deny") {
          process.exit(2);
        }
        // pending: true — keep polling
      }
    } catch {
      // daemon went away — deny
      process.exit(2);
    }

    await Bun.sleep(3000);
  }

  // Timed out on our end
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`[permission-hook] Fatal: ${err}\n`);
  process.exit(2);
});
