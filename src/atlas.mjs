import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { clientFromEnv, Config, ContextAtlasError, FileStore, Processor, formatOf, readBlocks } from '@phox-js/context-atlas';
import { dropVectors, ensureVectors, nearest, vectorsEnabled } from './vectors.mjs';

export const DATA_DIR = process.env.ATLAS_RECALL_DIR || join(homedir(), '.claude', 'context-atlas-recall');

const STORES = { sessions: 'sessions', memory: 'memory', files: 'files' };

/** A Jev client from the environment, or null when no key is set. */
export function jev() {
    try {
        return clientFromEnv();
    } catch {
        return null;
    }
}

/**
 * A processor with the user's config over the plugin's defaults. Three places reserved for the
 * top vector hits answer 31 of 42 reworded questions about real sessions against 27 with none.
 */
export function processor(client = jev()) {
    const path = process.env.ATLAS_RECALL_CONFIG;
    const own = path ? JSON.parse(readFileSync(path, 'utf8')) : {};

    return new Processor(client, Config.fromObject({ nearest_reserved: 3, ...own }));
}

export function store(kind) {
    return new FileStore(ensureDir(join(DATA_DIR, STORES[kind])));
}

/** The project folder name Claude Code keeps a session's transcript under, such as `-home-fox-git-app`. */
export function projectOf(transcriptPath) {
    return basename(dirname(transcriptPath));
}

/** Runs `work` while holding a lock directory, waiting up to `waitMs` for another holder. Null when the wait runs out. */
export async function withLock(name, work, waitMs = 120_000) {
    const path = join(ensureDir(join(DATA_DIR, 'locks')), name);
    const deadline = Date.now() + waitMs;

    for (;;) {
        try {
            mkdirSync(path);
            break;
        } catch {
            if (isStale(path)) {
                rmSync(path, { recursive: true, force: true });
                continue;
            }

            if (Date.now() > deadline) {
                return null;
            }

            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    try {
        return await work();
    } finally {
        rmSync(path, { recursive: true, force: true });
    }
}

export function sessionState(sessionId) {
    return readJson(statePath('sessions', sessionId), null);
}

/** Records which session a Claude Code process is running, for its MCP server to look up. */
export function recordProcessSession(pid, sessionId, transcriptPath, cwd) {
    writeJson(statePath('processes', String(pid)), { id: sessionId, transcript: transcriptPath, cwd });
}

/**
 * The session a Claude Code process is running, as its last SessionStart recorded it: indexed
 * state when there is some, else enough to index it.
 */
export function sessionOfProcess(pid) {
    const recorded = readJson(statePath('processes', String(pid)), null);

    if (recorded === null) {
        return null;
    }

    return sessionState(recorded.id) ?? { ...recorded, project: projectOf(recorded.transcript), lines: 0 };
}

/** Indexed sessions of a project, or of every project when `project` is null, latest first. */
export function sessionsOf(project) {
    const dir = join(DATA_DIR, 'state', 'sessions');

    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .map((file) => readJson(join(dir, file), null))
        .filter((state) => state !== null && (project === null || state.project === project) && state.lines > 0)
        .sort((a, b) => b.updated - a.updated);
}

/**
 * Brings a session's stored document up to its transcript: the whole transcript the first time,
 * then only the complete lines written since, through `append()`. Returns the number of new lines.
 */
export async function syncSession(sessionId, transcriptPath, cwd = null) {
    if (!existsSync(transcriptPath)) {
        // A session's first SessionStart runs before Claude Code writes its transcript.
        return 0;
    }

    const done = await withLock(`session-${safe(sessionId)}`, async () => {
        const state = sessionState(sessionId) ?? { id: sessionId, transcript: transcriptPath, project: projectOf(transcriptPath), cwd, lines: 0 };
        const text = readFileSync(transcriptPath, 'utf8');
        const complete = text.slice(0, text.lastIndexOf('\n') + 1);
        const lines = complete === '' ? [] : complete.slice(0, -1).split('\n');
        const compactedAt = lastCompaction(complete);

        const sessions = store('sessions');

        const bytes = Buffer.byteLength(complete);

        if (lines.length === state.lines) {
            if (compactedAt !== (state.compactedAt ?? null) || bytes !== state.bytes) {
                writeJson(statePath('sessions', sessionId), { ...state, compactedAt, bytes });
            }

            await backfill('sessions', sessions, sessionId);

            return 0;
        }

        const existing = state.lines > 0 && lines.length > state.lines ? sessions.document(sessionId) : null;
        let document;

        if (existing === null) {
            const blocks = chatBlocks(complete);

            if (blocks.length === 0) {
                // No message written yet: wait for one instead of storing an empty session.
                return 0;
            }

            document = await processor().ingestBlocks(blocks, sessionId, null);
        } else {
            const blocks = chatBlocks(lines.slice(state.lines).join('\n') + '\n');
            document = blocks.length === 0 ? existing : await processor().append(existing, blocks);
        }

        const added = lines.length - state.lines;
        sessions.put(document);
        writeJson(statePath('sessions', sessionId), { ...state, transcript: transcriptPath, cwd: cwd ?? state.cwd, lines: lines.length, bytes, compactedAt, updated: Date.now() });
        await embedQuietly('sessions', document);

        return added;
    });

    return done ?? 0;
}

/**
 * Passages of a compacted session that bear on `query`, for adding to a prompt: null before the
 * session's first compaction, and when every passage retrieved is from after the latest one,
 * which the model has in context.
 */
export async function passagesBeforeCompaction(sessionId, query) {
    const state = sessionState(sessionId);
    // A compaction since the last sync is in the transcript's unsynced tail: the hooks that sync
    // run before the boundary is written, or after the next prompt.
    const compactedAt = (state === null ? null : lastCompaction(unsyncedTail(state))) ?? state?.compactedAt ?? null;

    if (compactedAt === null) {
        return null;
    }

    const context = await retrieve('sessions', query, [sessionId]);

    if (context.abstained || context.text.trim() === '') {
        return null;
    }

    const times = new Map((store('sessions').document(sessionId)?.units ?? []).map((unit) => [unit.id, unit.meta?.time]));
    const isEarlier = context.sources.some((source) => {
        const time = times.get(source.unit);

        return typeof time === 'string' && time < compactedAt;
    });

    return isEarlier ? context.text : null;
}

/** What the transcript holds past the bytes the last sync read. */
function unsyncedTail(state) {
    try {
        const size = statSync(state.transcript).size;
        const from = Math.min(state.bytes ?? size, size);
        const buffer = Buffer.alloc(size - from);
        const fd = openSync(state.transcript, 'r');

        try {
            readSync(fd, buffer, 0, buffer.length, from);
        } finally {
            closeSync(fd);
        }

        return buffer.toString('utf8');
    } catch {
        return '';
    }
}

/** The timestamp of a transcript's latest compaction boundary, or null when it has none. */
export function lastCompaction(text) {
    // The marker can also appear quoted inside a message or tool output: only a row of that subtype counts.
    for (let at = text.lastIndexOf('"compact_boundary"'); at >= 0; at = text.lastIndexOf('"compact_boundary"', at - 1)) {
        const start = text.lastIndexOf('\n', at) + 1;
        const end = text.indexOf('\n', at);

        try {
            const row = JSON.parse(text.slice(start, end < 0 ? undefined : end));

            if (row.subtype === 'compact_boundary' && typeof row.timestamp === 'string') {
                return row.timestamp;
            }
        } catch {
            // a partial line, or the marker inside another row's text
        }

        at = start;
    }

    return null;
}

export function memoryDirOf(transcriptPath) {
    return join(dirname(transcriptPath), 'memory');
}

export function memoryIdsOf(project) {
    return Object.keys(readJson(statePath('memory', project), { files: {} }).files).map((file) => `${project}/${file}`);
}

/** Ingests the project's memory files that changed since the last sync and drops deleted ones. */
export async function syncMemory(project, memoryDir) {
    return withLock(`memory-${safe(project)}`, async () => {
        const state = readJson(statePath('memory', project), { files: {} });
        const present = existsSync(memoryDir) ? readdirSync(memoryDir).filter((file) => file.endsWith('.md') && file !== 'MEMORY.md') : [];
        const memory = store('memory');
        let changed = 0;

        for (const file of present) {
            const mtime = statSync(join(memoryDir, file)).mtimeMs;

            if (state.files[file] === mtime) {
                await backfill('memory', memory, `${project}/${file}`);
                continue;
            }

            const { title, body } = splitFrontmatter(readFileSync(join(memoryDir, file), 'utf8'));
            const document = await processor().ingest(body, `${project}/${file}`, 'markdown', null, title ?? file);
            memory.put(document);
            await embedQuietly('memory', document);
            state.files[file] = mtime;
            changed++;
        }

        for (const file of Object.keys(state.files)) {
            if (!present.includes(file)) {
                memory.remove(`${project}/${file}`);
                dropVectors(DATA_DIR, 'memory', `${project}/${file}`);
                delete state.files[file];
                changed++;
            }
        }

        writeJson(statePath('memory', project), state);

        return changed;
    });
}

/** The stored document id for a file, ingesting it first when it is new or changed since. */
export async function ensureFile(path) {
    const real = realpathSync(path);
    const { mtimeMs, size } = statSync(real);
    const id = createHash('sha256').update(real).digest('hex').slice(0, 32);

    await withLock(`file-${id}`, async () => {
        const state = readJson(statePath('files', id), null);

        if (state !== null && state.mtimeMs === mtimeMs && state.size === size) {
            await backfill('files', store('files'), id);

            return;
        }

        const client = processor();
        const document = formatOf(real) === null
            ? await client.ingest(readFileSync(real), id, 'text', null, basename(real))
            : await client.ingestFile(real, id, null, basename(real));

        store('files').put(document);
        await embedQuietly('files', document);
        writeJson(statePath('files', id), { path: real, mtimeMs, size });
    }, 600_000);

    return id;
}

export function isReadable(path) {
    return existsSync(path) && statSync(path).isFile() && extname(path) !== '.lock';
}

/** Context for `query` from one store, kept to `documents`. Throws when Jev is not configured or does not answer. */
export async function retrieve(kind, query, documents) {
    const client = jev();

    if (client === null) {
        throw new Error('No Jev key: set TYPESAFE_API_KEY (or OPENROUTER_API_KEY with TYPESAFE_PROVIDER=openrouter) in the environment Claude Code runs in.');
    }

    const options = vectorsEnabled() ? { documents, nearest: nearest(DATA_DIR, kind) } : { documents };
    const context = await processor(client).retrieve(query, store(kind), options);

    if (context === null) {
        throw new Error('Jev did not answer. Check the API key and try again.');
    }

    return context;
}

/** Embeds a stored document's units; a failure leaves them to exact-term search until the next sync retries. */
async function embedQuietly(kind, document) {
    try {
        await ensureVectors(DATA_DIR, kind, document);
    } catch (error) {
        logError(`embedding ${kind}/${document.id}: ${error?.message ?? error}`);
    }
}

/** Embeds what an earlier sync left without vectors (no key then, or a failed request). */
async function backfill(kind, documents, id) {
    const document = vectorsEnabled() ? documents.document(id) : null;

    if (document !== null) {
        await embedQuietly(kind, document);
    }
}

export function logError(line) {
    try {
        mkdirSync(DATA_DIR, { recursive: true });
        appendFileSync(join(DATA_DIR, 'errors.log'), `${new Date().toISOString()} ${line}\n`);
    } catch {
        // nowhere left to report it
    }
}

/**
 * The chat reader's blocks for transcript lines, none for lines it does not take as a chat log:
 * a batch of new lines can hold only rows such as `file-history-snapshot`, which carry no
 * `sessionId`.
 */
function chatBlocks(text) {
    try {
        return readBlocks(text, 'chat');
    } catch (error) {
        if (error instanceof ContextAtlasError) {
            return [];
        }

        throw error;
    }
}

function splitFrontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);

    if (match === null) {
        return { title: null, body: text };
    }

    const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(match[1])?.[1].trim() ?? null;
    const name = field('name');
    const description = field('description');

    return { title: [name, description].filter(Boolean).join(': ') || null, body: text.slice(match[0].length) };
}

function statePath(kind, key) {
    return join(DATA_DIR, 'state', kind, `${safe(key)}.json`);
}

function safe(key) {
    return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

function isStale(path) {
    try {
        return Date.now() - statSync(path).mtimeMs > 15 * 60_000;
    } catch {
        return false;
    }
}

function ensureDir(path) {
    mkdirSync(path, { recursive: true });

    return path;
}

function readJson(path, fallback) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(path, value) {
    ensureDir(dirname(path));
    writeFileSync(path, JSON.stringify(value));
}
