/**
 * x811 MCP Server — Message buffer utilities.
 *
 * Provides a persistent file-backed message buffer that survives process restarts.
 * Uses atomic writes (write to .tmp, then rename) and TTL-based cleanup.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.X811_STATE_DIR || join(homedir(), ".x811");
const BUFFER_FILE = join(STATE_DIR, "message-buffer.json");
const BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUFFER_SIZE = 1000;
let sequenceCounter = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BufferEntry {
  seq: number;
  message: Record<string, unknown>;
  timestamp: number;
}

interface BufferFile {
  version: 1;
  entries: BufferEntry[];
}

// ---------------------------------------------------------------------------
// In-memory buffer — primary store, flushed to disk on every mutation
// ---------------------------------------------------------------------------

const buffer: BufferEntry[] = [];

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

function saveBuffer(): void {
  try {
    ensureStateDir();
    const data: BufferFile = { version: 1, entries: buffer };
    const json = JSON.stringify(data);
    const tmpFile = BUFFER_FILE + ".tmp";
    writeFileSync(tmpFile, json, { mode: 0o600 });
    renameSync(tmpFile, BUFFER_FILE);
  } catch (err) {
    process.stderr.write(
      `[x811:buffer] Failed to persist buffer: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function loadBuffer(): void {
  if (!existsSync(BUFFER_FILE)) return;
  try {
    const raw = readFileSync(BUFFER_FILE, "utf-8");
    const data = JSON.parse(raw) as BufferFile;
    if (data.version !== 1 || !Array.isArray(data.entries)) {
      process.stderr.write("[x811:buffer] Invalid buffer file format, starting fresh\n");
      return;
    }
    const now = Date.now();
    for (const entry of data.entries) {
      if (now - entry.timestamp < BUFFER_TTL_MS) {
        buffer.push(entry);
        if (entry.seq >= sequenceCounter) {
          sequenceCounter = entry.seq + 1;
        }
      }
    }
    process.stderr.write(`[x811:buffer] Loaded ${buffer.length} messages from disk (discarded ${data.entries.length - buffer.length} expired)\n`);
  } catch {
    process.stderr.write("[x811:buffer] Failed to load buffer file, starting fresh\n");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the buffer — load persisted entries from disk.
 * Call once at startup.
 */
export function initBuffer(): void {
  loadBuffer();
}

/**
 * Push a message into the buffer. Persists to disk.
 */
export function pushToBuffer(msg: Record<string, unknown>): void {
  pruneExpired();
  if (buffer.length >= MAX_BUFFER_SIZE) {
    // Drop oldest entries to make room
    const excess = buffer.length - MAX_BUFFER_SIZE + 1;
    buffer.splice(0, excess);
  }
  buffer.push({
    seq: sequenceCounter++,
    message: msg,
    timestamp: Date.now(),
  });
  saveBuffer();
}

/**
 * Find and remove a message of the given type from the buffer.
 * Returns the message if found, null otherwise.
 */
export function consumeFromBuffer(type: string): Record<string, unknown> | null {
  pruneExpired();
  const idx = buffer.findIndex((entry) => entry.message.type === type);
  if (idx === -1) return null;
  const entry = buffer.splice(idx, 1)[0];
  saveBuffer();
  return entry.message;
}

/**
 * Drain all messages from the buffer (for x811_poll tool).
 * Returns all messages and clears the buffer.
 */
export function drainBuffer(): Record<string, unknown>[] {
  pruneExpired();
  const messages = buffer.map((entry) => entry.message);
  buffer.length = 0;
  saveBuffer();
  return messages;
}

/**
 * Get the current buffer size (for logging).
 */
export function bufferSize(): number {
  return buffer.length;
}

// ---------------------------------------------------------------------------
// Internal: TTL pruning
// ---------------------------------------------------------------------------

function pruneExpired(): void {
  const now = Date.now();
  let pruned = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (now - buffer[i].timestamp >= BUFFER_TTL_MS) {
      buffer.splice(i, 1);
      pruned++;
    }
  }
  if (pruned > 0) {
    process.stderr.write(`[x811:buffer] Pruned ${pruned} expired entries\n`);
  }
}
