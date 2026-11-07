import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sanitizeFilename } from './attachments.js';

export interface RequestContext {
  baseUrl?: string | undefined;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T
): T {
  return requestContext.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export interface StagedTempFile {
  token: string;
  tempPath: string;
  entryDir: string;
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAtMs: number;
  expiresAtMs: number;
  expiresAt: string;
  downloadUrl: string | undefined;
}

const stagedFiles = new Map<string, StagedTempFile>();
const activeRoots = new Set<string>();
let defaultRootPromise: Promise<string> | undefined;
let sweepTimer: NodeJS.Timeout | undefined;
let exitHookInstalled = false;

const SWEEP_INTERVAL_MS = 30_000;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const entry of stagedFiles.values()) {
      try {
        rmSync(entry.entryDir, { recursive: true, force: true });
      } catch {
        // Best-effort teardown on process exit.
      }
    }
    stagedFiles.clear();
    for (const root of activeRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort teardown on process exit.
      }
    }
    activeRoots.clear();
  });
}

function ensureSweepTimer(): void {
  if (sweepTimer !== undefined) return;
  sweepTimer = setInterval(() => {
    void sweepExpiredTempFiles();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

async function ensureRootDir(
  customBaseDir?: string | undefined
): Promise<string> {
  installExitHook();
  if (customBaseDir !== undefined) {
    const dir = join(
      customBaseDir,
      `ufsc-email-mcp-${process.pid}-${randomBytes(6).toString('hex')}`
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    activeRoots.add(dir);
    return dir;
  }
  if (defaultRootPromise === undefined) {
    defaultRootPromise = (async () => {
      const dir = join(
        tmpdir(),
        `ufsc-email-mcp-${process.pid}-${randomBytes(8).toString('hex')}`
      );
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      activeRoots.add(dir);
      return dir;
    })();
  }
  return defaultRootPromise;
}

/** Safe single-segment filename for disk staging and Content-Disposition. */
export function toSafeDownloadFilename(raw: string | undefined): string {
  const cleaned = sanitizeFilename(raw)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '');
  if (cleaned === '' || cleaned === 'unnamed') return 'attachment.bin';
  return cleaned.slice(0, 100);
}

export async function sweepExpiredTempFiles(
  nowMs: number = Date.now()
): Promise<number> {
  let removed = 0;
  for (const [token, entry] of stagedFiles.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      stagedFiles.delete(token);
      removed += 1;
      await rm(entry.entryDir, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
  return removed;
}

export async function cleanupAllTempFiles(): Promise<void> {
  if (sweepTimer !== undefined) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
  const dirs = [...stagedFiles.values()].map((entry) => entry.entryDir);
  stagedFiles.clear();
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  const roots = [...activeRoots];
  activeRoots.clear();
  defaultRootPromise = undefined;
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface MaterializeOptions {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  ttlSeconds: number;
  publicBaseUrl?: string | undefined;
  tempDir?: string | undefined;
  nowMs?: number | undefined;
}

export async function materializeTempFile(
  options: MaterializeOptions
): Promise<StagedTempFile> {
  const nowMs = options.nowMs ?? Date.now();
  await sweepExpiredTempFiles(nowMs);
  ensureSweepTimer();

  const root = await ensureRootDir(options.tempDir);
  const entryDir = join(root, randomBytes(12).toString('hex'));
  await mkdir(entryDir, { mode: 0o700 });
  await chmod(entryDir, 0o700);

  const safeFilename = toSafeDownloadFilename(options.filename);
  const tempPath = join(entryDir, safeFilename);
  await writeFile(tempPath, options.bytes, { mode: 0o600, flag: 'wx' });
  await chmod(tempPath, 0o600);

  const token = `dl_${randomBytes(32).toString('hex')}`;
  const sha256 = createHash('sha256').update(options.bytes).digest('hex');
  const expiresAtMs = nowMs + options.ttlSeconds * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const baseUrl = (
    options.publicBaseUrl ?? getRequestContext()?.baseUrl
  )?.replace(/\/+$/, '');
  const downloadUrl =
    baseUrl !== undefined && baseUrl !== ''
      ? `${baseUrl}/files/${token}/${encodeURIComponent(safeFilename)}`
      : undefined;

  const staged: StagedTempFile = {
    token,
    tempPath,
    entryDir,
    filename: safeFilename,
    mimeType: safeServedMimeType(options.mimeType),
    bytes: options.bytes.length,
    sha256,
    createdAtMs: nowMs,
    expiresAtMs,
    expiresAt,
    downloadUrl,
  };
  stagedFiles.set(token, staged);
  return staged;
}

/**
 * Resolves a capability download token if valid, unexpired, and still present on disk.
 */
export async function resolveTempDownload(
  token: string,
  nowMs: number = Date.now()
): Promise<StagedTempFile | undefined> {
  if (!/^dl_[0-9a-f]{64}$/.test(token)) return undefined;
  await sweepExpiredTempFiles(nowMs);
  const entry = stagedFiles.get(token);
  if (entry === undefined) return undefined;
  if (entry.expiresAtMs <= nowMs) {
    stagedFiles.delete(token);
    await rm(entry.entryDir, { recursive: true, force: true }).catch(
      () => undefined
    );
    return undefined;
  }
  try {
    const info = await stat(entry.tempPath);
    if (!info.isFile()) return undefined;
  } catch {
    stagedFiles.delete(token);
    return undefined;
  }
  return entry;
}

/** Never serve active HTML/SVG/XML scriptable types as renderable browser documents. */
function safeServedMimeType(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (
    lower === 'text/html' ||
    lower === 'application/xhtml+xml' ||
    lower === 'image/svg+xml' ||
    lower === 'text/xml' ||
    lower === 'application/xml'
  ) {
    return 'application/octet-stream';
  }
  return lower;
}
