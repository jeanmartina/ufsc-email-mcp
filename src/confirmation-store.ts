import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfirmationStore, setResourceKey } from 'mcp-approval';

export interface ConfirmationEntry {
  token: string;
  resourceKey: string;
  issuedAt: number;
  expiresAt: number;
}

export function constantTimeEquals(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(Buffer.from(a, 'utf8')).digest();
  const hashB = crypto.createHash('sha256').update(Buffer.from(b, 'utf8')).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function getConfirmationsDirectory(): string {
  if (process.env.MCP_CONFIRMATIONS_DIR && process.env.MCP_CONFIRMATIONS_DIR.trim()) {
    return process.env.MCP_CONFIRMATIONS_DIR.trim();
  }
  return path.join(os.tmpdir(), 'ufsc-imap-confirmations');
}

/**
 * A ConfirmationStore that persists tokens to disk with atomic operations,
 * ensuring tokens survive across stateless HTTP requests, process restarts,
 * and multi-process / worker instances.
 */
export class PersistentConfirmationStore extends ConfirmationStore {
  readonly storageDir: string;
  private readonly memoryCache = new Map<string, { token: string; expiresAt: number }>();
  private readonly spentTokens = new Map<string, number>();

  constructor(ttlMs = 5 * 60 * 1000, storageDir?: string) {
    super(ttlMs);
    this.storageDir = storageDir ?? getConfirmationsDirectory();
    this.ensureStorageDir();
  }

  private ensureStorageDir(): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
      }
    } catch (err) {
      console.error('imap-mcp: warning: failed to initialize confirmations directory:', err);
    }
  }

  private resourceKeyToFilename(resourceKey: string): string {
    const hash = crypto.createHash('sha256').update(resourceKey).digest('hex');
    return path.join(this.storageDir, `tok_${hash}.json`);
  }

  private spentTokenToFilename(token: string): string {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    return path.join(this.storageDir, `spent_${hash}.json`);
  }

  private sweepExpiredFiles(): void {
    try {
      const now = Date.now();
      for (const [key, entry] of this.memoryCache.entries()) {
        if (now >= entry.expiresAt) {
          this.memoryCache.delete(key);
        }
      }
      for (const [token, exp] of this.spentTokens.entries()) {
        if (now >= exp) {
          this.spentTokens.delete(token);
        }
      }

      if (!fs.existsSync(this.storageDir)) return;
      const files = fs.readdirSync(this.storageDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.storageDir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw);
          if (data && typeof data.expiresAt === 'number' && now >= data.expiresAt) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // ignore concurrent unlinks
        }
      }
    } catch {
      // ignore sweep errors
    }
  }

  override issue(resource: string): string {
    this.sweepExpiredFiles();

    const now = Date.now();
    const expiresAt = now + this.ttlMinutes * 60 * 1000;
    const token = crypto.randomBytes(16).toString('hex');

    // 1. Update in-memory cache
    this.memoryCache.set(resource, { token, expiresAt });

    // 2. Persist to disk atomically
    try {
      this.ensureStorageDir();
      const filePath = this.resourceKeyToFilename(resource);
      const tmpPath = path.join(
        this.storageDir,
        `tmp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.json`
      );
      const payload: ConfirmationEntry = {
        token,
        resourceKey: resource,
        issuedAt: now,
        expiresAt,
      };
      fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      console.error('imap-mcp: warning: failed to write confirmation token to disk:', err);
    }

    return token;
  }

  override consume(resource: string, token: string | undefined): boolean {
    if (!token || typeof token !== 'string') return false;
    const now = Date.now();

    // Check if token was already spent
    const spentExp = this.spentTokens.get(token);
    if (spentExp && now < spentExp) {
      return false;
    }

    const spentFilePath = this.spentTokenToFilename(token);
    try {
      if (fs.existsSync(spentFilePath)) {
        return false;
      }
    } catch {
      // ignore
    }

    let candidateToken: string | undefined;
    let candidateExpiresAt: number | undefined;
    let diskFilePath: string | undefined;

    // Check disk first for cross-process synchronization
    try {
      diskFilePath = this.resourceKeyToFilename(resource);
      if (fs.existsSync(diskFilePath)) {
        const raw = fs.readFileSync(diskFilePath, 'utf8');
        const data = JSON.parse(raw) as ConfirmationEntry;
        if (data && typeof data.token === 'string') {
          candidateToken = data.token;
          candidateExpiresAt = data.expiresAt;
        }
      }
    } catch {
      // fallback to memory
    }

    // Fallback to in-memory cache if not found on disk
    if (!candidateToken) {
      const mem = this.memoryCache.get(resource);
      if (mem) {
        candidateToken = mem.token;
        candidateExpiresAt = mem.expiresAt;
      }
    }

    if (!candidateToken || candidateExpiresAt === undefined) {
      return false;
    }

    if (now >= candidateExpiresAt) {
      this.memoryCache.delete(resource);
      if (diskFilePath && fs.existsSync(diskFilePath)) {
        try {
          fs.unlinkSync(diskFilePath);
        } catch {}
      }
      return false;
    }

    if (!constantTimeEquals(token, candidateToken)) {
      // Token mismatch: do NOT consume the valid token on a typo or wrong token
      return false;
    }

    // MATCH: Atomically consume the token (single use guarantee)
    this.memoryCache.delete(resource);
    this.spentTokens.set(token, now + this.ttlMinutes * 60 * 1000);

    let consumedSuccessfully = true;
    if (diskFilePath) {
      try {
        if (fs.existsSync(diskFilePath)) {
          fs.unlinkSync(diskFilePath);
        } else {
          // Another concurrent process already consumed this token file
          consumedSuccessfully = false;
        }
      } catch {
        consumedSuccessfully = false;
      }
    }

    if (consumedSuccessfully) {
      try {
        this.ensureStorageDir();
        const tmpSpent = path.join(
          this.storageDir,
          `tmp_spent_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.json`
        );
        fs.writeFileSync(
          tmpSpent,
          JSON.stringify({
            token,
            resourceKey: resource,
            spentAt: now,
            expiresAt: now + this.ttlMinutes * 60 * 1000,
          }),
          { mode: 0o600 }
        );
        fs.renameSync(tmpSpent, spentFilePath);
      } catch {
        // ignore spent mark write error
      }
    }

    return consumedSuccessfully;
  }
}

export interface MoveTargetSpec {
  uids: number[];
  destination: string;
}

/**
 * Builds a deterministic canonical resource key for message move/copy operations.
 *
 * Guarantees:
 * - Order of JSON properties does not affect the key.
 * - Order of UIDs within arrays does not affect the key (sorted numerically).
 * - Order of destinations does not affect the key (sorted deterministically).
 * - "moves" batch and top-level "uids"/"destination" yield the exact same key when representing the same target set.
 * - Normalized mailbox names (e.g. INBOX is case-insensitive per RFC 3501).
 * - "mode" defaults to "move" deterministically.
 * - "mark_as_read" defaults to false deterministically.
 * - "confirm_token" is excluded from the resource key.
 */
export function buildCanonicalMoveResourceKey(params: {
  source: string;
  mode?: string | undefined;
  markAsRead?: boolean | undefined;
  uids?: number[] | undefined;
  destination?: string | undefined;
  moves?: MoveTargetSpec[] | undefined;
}): string {
  const mode = params.mode === 'copy' ? 'copy' : 'move';
  const markAsRead = Boolean(params.markAsRead);
  const rawSource = params.source.trim();
  const source = rawSource.toUpperCase() === 'INBOX' ? 'INBOX' : rawSource;

  const rawTargets: MoveTargetSpec[] = [];
  if (params.moves && Array.isArray(params.moves) && params.moves.length > 0) {
    for (const m of params.moves) {
      if (m && Array.isArray(m.uids) && m.destination) {
        rawTargets.push({ uids: m.uids, destination: m.destination });
      }
    }
  } else if (params.uids && Array.isArray(params.uids) && params.destination) {
    rawTargets.push({ uids: params.uids, destination: params.destination });
  }

  const pairs: Array<{ destination: string; uid: number }> = [];
  for (const target of rawTargets) {
    const rawDest = String(target.destination).trim();
    const dest = rawDest.toUpperCase() === 'INBOX' ? 'INBOX' : rawDest;
    for (const rawUid of target.uids) {
      const uid = Math.floor(Number(rawUid));
      if (!Number.isNaN(uid) && uid > 0) {
        pairs.push({ destination: dest, uid });
      }
    }
  }

  pairs.sort((a, b) => {
    const cmp = a.destination.localeCompare(b.destination);
    return cmp !== 0 ? cmp : a.uid - b.uid;
  });

  const dedupedStrings: string[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const str = `${JSON.stringify(p.destination)}:${p.uid}`;
    if (!seen.has(str)) {
      seen.add(str);
      dedupedStrings.push(str);
    }
  }

  const operation = `${mode}_messages:${JSON.stringify({ source, mark_as_read: markAsRead })}`;
  return setResourceKey(operation, dedupedStrings);
}
