// A local vector store over stored documents' units, embedded through OpenRouter's embeddings
// endpoint. One file per document under `vectors/<kind>/`, searched by brute-force cosine,
// which stays fast at the size of a conversation or a set of memory files.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = process.env.ATLAS_RECALL_EMBED_MODEL || 'openai/text-embedding-3-small';
const ENDPOINT = `${(process.env.ATLAS_RECALL_EMBED_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/embeddings`;
// The model reads up to 8,191 tokens.
const MAX_CHARS = 6_000;
// Bumped when what is embedded for a unit changes, so stored vectors are rebuilt.
const SCHEME = `${MODEL}#4`;
const BATCH_INPUTS = 96;
const BATCH_CHARS = 120_000;

/** Whether embeddings are configured: an OpenRouter key, and not turned off. */
export function vectorsEnabled() {
    return process.env.ATLAS_RECALL_VECTORS !== '0' && (process.env.OPENROUTER_API_KEY ?? '').trim() !== '';
}

/**
 * Embeds the units of `document` that have no vector, or whose text changed, and drops vectors of
 * units it no longer has. Tool calls and outputs are embedded with the prose: without them,
 * retrieval answers 22 of 148 questions about tool output against 88 with them, while answering
 * 73 of 84 questions about the conversation's prose against 67.
 */
export async function ensureVectors(dataDir, kind, document) {
    if (!vectorsEnabled()) {
        return 0;
    }

    const path = fileOf(dataDir, kind, document.id);
    const stored = load(path);
    const fresh = stored !== null && stored.model === SCHEME ? stored : { model: SCHEME, document: document.id, dims: 0, units: {} };
    const units = {};
    const missing = [];

    for (const unit of document.units) {
        const hash = hashOf(embeddingText(unit));
        const known = fresh.units[unit.id];

        if (known !== undefined && known.hash === hash) {
            units[unit.id] = known;
        } else {
            missing.push({ unit, hash });
        }
    }

    const vectors = await embed(missing.map(({ unit }) => embeddingText(unit)));

    missing.forEach(({ unit, hash }, i) => {
        units[unit.id] = { hash, kind: unit.kind, vector: vectors[i] };
    });

    if (missing.length > 0 || Object.keys(units).length !== Object.keys(fresh.units).length) {
        save(path, { model: SCHEME, document: document.id, dims: vectors[0]?.length ?? fresh.dims, units });
    }

    return missing.length;
}

export function dropVectors(dataDir, kind, documentId) {
    rmSync(fileOf(dataDir, kind, documentId), { force: true });
}

/** context-atlas's `nearest` callback over one kind of store: the units closest to the query, best first. */
export function nearest(dataDir, kind) {
    return async (query, limit, kinds, documents) => {
        let queryVector;

        try {
            queryVector = await embedQuery(query);
        } catch {
            // No embedding for the query: retrieval goes on with exact terms alone.
            return [];
        }

        const dir = join(dataDir, 'vectors', kind);
        const files = documents === null
            ? (existsSync(dir) ? readdirSync(dir).map((file) => join(dir, file)) : [])
            : documents.map((id) => fileOf(dataDir, kind, id));
        const hits = [];

        for (const file of files) {
            const stored = load(file);

            if (stored === null || stored.model !== SCHEME) {
                continue;
            }

            for (const [unit, entry] of Object.entries(stored.units)) {
                if (kinds === null || kinds.includes(entry.kind)) {
                    hits.push({ document: stored.document, unit, score: dot(queryVector, entry.vector) });
                }
            }
        }

        return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ document, unit }) => ({ document, unit }));
    };
}

/** A unit's text without the `[speaker, time]` line the chat reader heads it with. */
function embeddingText(unit) {
    return withoutHeader(unit).slice(0, MAX_CHARS);
}

function withoutHeader(unit) {
    return unit.text.replace(/^\[[^\]\n]*\]\n/, '');
}

const queries = new Map();

/** One embedding per query per process: retrieval and its callers can ask for the same query twice. */
async function embedQuery(query) {
    if (!queries.has(query)) {
        queries.set(query, embed([query]).then(([vector]) => vector));
        queries.get(query).catch(() => queries.delete(query));
    }

    return queries.get(query);
}

async function embed(texts) {
    const vectors = [];

    for (const batch of batches(texts.map((text) => text || ' '))) {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, input: batch }),
            signal: AbortSignal.timeout(60_000),
        });
        const body = await response.json().catch(() => null);

        if (!response.ok || !Array.isArray(body?.data) || body.data.length !== batch.length) {
            throw new Error(`Embedding request failed (${response.status}): ${JSON.stringify(body?.error ?? body).slice(0, 300)}`);
        }

        body.data.sort((a, b) => a.index - b.index).forEach((item) => vectors.push(Float32Array.from(item.embedding)));
    }

    return vectors;
}

function* batches(texts) {
    let batch = [];
    let chars = 0;

    for (const text of texts) {
        if (batch.length > 0 && (batch.length === BATCH_INPUTS || chars + text.length > BATCH_CHARS)) {
            yield batch;
            batch = [];
            chars = 0;
        }

        batch.push(text);
        chars += text.length;
    }

    if (batch.length > 0) {
        yield batch;
    }
}

function dot(a, b) {
    let sum = 0;

    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }

    return sum;
}

function fileOf(dataDir, kind, documentId) {
    return join(dataDir, 'vectors', kind, `${createHash('sha256').update(documentId).digest('hex').slice(0, 32)}.json`);
}

function hashOf(text) {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function load(path) {
    try {
        const stored = JSON.parse(readFileSync(path, 'utf8'));

        for (const entry of Object.values(stored.units)) {
            const bytes = Buffer.from(entry.vector, 'base64');
            entry.vector = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        }

        return stored;
    } catch {
        return null;
    }
}

function save(path, stored) {
    const units = Object.fromEntries(Object.entries(stored.units).map(([id, entry]) => [
        id,
        { ...entry, vector: Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength).toString('base64') },
    ]));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...stored, units }));
}
