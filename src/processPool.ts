/**
 * Persistent Claude process pool.
 *
 * Instead of spawning `claude -p "prompt"` for every message (which re-initialises
 * the full Claude Code runtime each time), we keep one long-running `claude`
 * process per session alive between messages.  Each message is written to the
 * process's stdin; the process responds with stream-json events ending with a
 * `result` event, then waits for the next message.
 *
 * Benefits:
 *  - No per-message startup overhead (~1-2 s per invocation avoided)
 *  - System prompt / CLAUDE.md injected once at spawn, not on every call
 *  - PermissionRequest hook fires normally (process is alive and paused, not dead)
 *  - Much shorter command lines
 *
 * Pool semantics:
 *  - Keyed by session key (e.g. "global" or a thread ID)
 *  - Max MAX_POOL_SIZE entries; oldest idle process is evicted when full
 *  - Idle processes are killed after IDLE_TIMEOUT_MS
 *  - Dead processes are automatically replaced on next send
 */

const MAX_POOL_SIZE = 5;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface PoolEntry {
  proc: ReturnType<typeof Bun.spawn>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  /** Claude-side session UUID (populated after first response). */
  sessionId: string | null;
  lastUsed: number;
  busy: boolean;
  /** Partial line buffer for stream-json parsing. */
  buf: string;
}

const pool = new Map<string, PoolEntry>();

function isAlive(entry: PoolEntry): boolean {
  try {
    return entry.proc.exitCode === null;
  } catch {
    return false;
  }
}

function evictOldest(): void {
  if (pool.size <= MAX_POOL_SIZE) return;
  let oldestKey = "";
  let oldestTime = Infinity;
  for (const [k, e] of pool.entries()) {
    if (!e.busy && e.lastUsed < oldestTime) {
      oldestTime = e.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey) killEntry(oldestKey);
}

function killEntry(key: string): void {
  const e = pool.get(key);
  if (!e) return;
  try { e.proc.kill(); } catch {}
  pool.delete(key);
}

/** Kill all pooled processes (call on daemon shutdown). */
export function killAll(): void {
  for (const key of [...pool.keys()]) killEntry(key);
}

/** Kill the pool entry for a specific session key (e.g. on /compact). */
export function killSession(key: string): void {
  killEntry(key);
}

export function getPoolStats(): { size: number; keys: string[] } {
  return { size: pool.size, keys: [...pool.keys()] };
}

// Idle cleanup — runs every minute
const idleCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, e] of pool.entries()) {
    if (!e.busy && now - e.lastUsed > IDLE_TIMEOUT_MS) {
      console.log(`[ProcessPool] Evicting idle session: ${k}`);
      killEntry(k);
    }
  }
}, 60_000);
// Don't block process exit
if (typeof idleCleanupTimer.unref === "function") idleCleanupTimer.unref();

// ---------------------------------------------------------------------------
// Stream-json parsing
// ---------------------------------------------------------------------------

interface StreamResult {
  text: string;
  /** Session ID from system/init event — only present on first response. */
  sessionId?: string;
}

async function readUntilResult(entry: PoolEntry): Promise<StreamResult> {
  let resultText = "";
  let sessionId: string | undefined;

  while (true) {
    const { done, value } = await entry.reader.read();
    if (done) throw new Error("[ProcessPool] Process exited while reading response");

    entry.buf += decoder.decode(value, { stream: true });
    const lines = entry.buf.split("\n");
    entry.buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        // Capture session ID from init event (new sessions only)
        if (event.type === "system" && (event.subtype === "init" || event.session_id)) {
          const sid = event.session_id as string | undefined;
          if (sid) sessionId = sid;
        } else if (event.type === "result") {
          resultText = (event.result as string) ?? "";
          return { text: resultText, sessionId };
        }
        // assistant / tool_use / rate_limit_event etc. — ignore for text collection;
        // streamUserMessage uses a separate streaming path that doesn't use this pool.
      } catch {
        // Non-JSON line — ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SendOptions {
  /** Pre-built args to spawn the process with (excluding the prompt). */
  spawnArgs: string[];
  /** Environment variables for the child process. */
  env: Record<string, string>;
  /** Known Claude session ID to resume, if any. */
  existingSessionId: string | null;
}

/**
 * Send a message to a pooled persistent process.
 *
 * If no live process exists for `key`, spawns one using `options.spawnArgs`.
 * Returns the response text and the session ID (populated on the first call
 * for a new session).
 */
export async function sendToPool(
  key: string,
  message: string,
  options: SendOptions,
): Promise<{ text: string; sessionId?: string; exitCode?: number }> {
  let entry = pool.get(key);

  if (!entry || !isAlive(entry)) {
    if (entry) pool.delete(key);

    const args = options.existingSessionId
      ? [...options.spawnArgs, "--resume", options.existingSessionId]
      : options.spawnArgs;

    console.log(`[ProcessPool] Spawning for key=${key}${options.existingSessionId ? ` (resume ${options.existingSessionId.slice(0, 8)})` : " (new session)"}`);

    const proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: options.env,
    });

    entry = {
      proc,
      reader: (proc.stdout as ReadableStream<Uint8Array>).getReader(),
      writer: (proc.stdin as WritableStream<Uint8Array>).getWriter(),
      sessionId: options.existingSessionId,
      lastUsed: Date.now(),
      busy: false,
      buf: "",
    };

    pool.set(key, entry);
    evictOldest();
  }

  // Serialize: wait if another message is in flight for this session
  while (entry.busy) await Bun.sleep(50);

  entry.busy = true;
  entry.lastUsed = Date.now();

  try {
    await entry.writer.write(encoder.encode(message + "\n"));
    const result = await readUntilResult(entry);
    if (result.sessionId) entry.sessionId = result.sessionId;
    return { text: result.text, sessionId: result.sessionId };
  } catch (err) {
    // Process died mid-response — remove from pool so next call re-spawns
    console.error(`[ProcessPool] Error for key=${key}:`, err);
    killEntry(key);
    throw err;
  } finally {
    entry.busy = false;
    entry.lastUsed = Date.now();
  }
}
