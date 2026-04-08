// Permission bridge — forwards Claude Code PermissionRequest hooks to Discord/Telegram

type Decision = 'allow' | 'deny';

interface PendingPermission {
  id: string;
  toolName: string;
  toolInput: unknown;
  timestamp: number;
  resolve: (d: Decision) => void;
  discordMessageIds?: { channelId: string; messageId: string }[];
  telegramMessageIds?: { chatId: number; messageId: number }[];
}

type BroadcastCallback = (perm: Omit<PendingPermission, 'resolve'>) => void;

const pending = new Map<string, PendingPermission>();
const broadcasters: BroadcastCallback[] = [];

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function onBroadcast(cb: BroadcastCallback): void {
  broadcasters.push(cb);
}

export function registerPermission(request: {
  id: string;
  toolName: string;
  toolInput: unknown;
}): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    const perm: PendingPermission = {
      id: request.id,
      toolName: request.toolName,
      toolInput: request.toolInput,
      timestamp: Date.now(),
      resolve,
      discordMessageIds: [],
      telegramMessageIds: [],
    };

    pending.set(request.id, perm);

    // Auto-deny after timeout
    setTimeout(() => {
      if (pending.has(request.id)) {
        console.log(`[Permissions] Auto-denying ${request.id} (timeout)`);
        resolvePermission(request.id, 'deny');
      }
    }, TIMEOUT_MS);

    // Broadcast to all registered channels (non-blocking)
    const snapshot: Omit<PendingPermission, 'resolve'> = {
      id: perm.id,
      toolName: perm.toolName,
      toolInput: perm.toolInput,
      timestamp: perm.timestamp,
      discordMessageIds: perm.discordMessageIds,
      telegramMessageIds: perm.telegramMessageIds,
    };
    for (const cb of broadcasters) {
      try {
        cb(snapshot);
      } catch (err) {
        console.error(`[Permissions] Broadcaster error:`, err);
      }
    }
  });
}

export function resolvePermission(id: string, decision: Decision): boolean {
  const perm = pending.get(id);
  if (!perm) return false;
  pending.delete(id);
  perm.resolve(decision);
  return true;
}

export function getPending(): Omit<PendingPermission, 'resolve'>[] {
  return Array.from(pending.values()).map((p) => ({
    id: p.id,
    toolName: p.toolName,
    toolInput: p.toolInput,
    timestamp: p.timestamp,
    discordMessageIds: p.discordMessageIds,
    telegramMessageIds: p.telegramMessageIds,
  }));
}

export function attachDiscordMessage(
  id: string,
  channelId: string,
  messageId: string,
): void {
  const perm = pending.get(id);
  if (!perm) return;
  perm.discordMessageIds = perm.discordMessageIds ?? [];
  perm.discordMessageIds.push({ channelId, messageId });
}

export function attachTelegramMessage(
  id: string,
  chatId: number,
  messageId: number,
): void {
  const perm = pending.get(id);
  if (!perm) return;
  perm.telegramMessageIds = perm.telegramMessageIds ?? [];
  perm.telegramMessageIds.push({ chatId, messageId });
}
