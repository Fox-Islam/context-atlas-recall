import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// No keys and a private data directory: indexing runs without Jev and nothing reaches the network.
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-recall-test-'));
const env = { ...process.env, ATLAS_RECALL_DIR: dataDir };
for (const key of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'TYPESAFE_PROVIDER']) {
    delete process.env[key];
    delete env[key];
}
process.env.ATLAS_RECALL_DIR = dataDir;

const { Processor } = await import('@phox-js/context-atlas');
const { lastCompaction, passagesBeforeCompaction, processor, projectOf, recordProcessSession, sessionOfProcess, sessionState, store, syncSession } = await import('../src/atlas.mjs');
const { ensureVectors } = await import('../src/vectors.mjs');

const root = new URL('..', import.meta.url).pathname;
let row = 0;

function user(text, extra = {}) {
    row++;
    return JSON.stringify({ type: 'user', uuid: `u${row}`, timestamp: `2026-10-01T10:00:${String(row).padStart(2, '0')}.000Z`, message: { role: 'user', content: text }, ...extra });
}

function assistant(text) {
    row++;
    return JSON.stringify({ type: 'assistant', uuid: `a${row}`, timestamp: `2026-10-01T10:00:${String(row).padStart(2, '0')}.000Z`, message: { id: `msg${row}`, role: 'assistant', content: [{ type: 'text', text }] } });
}

function boundary(timestamp) {
    return JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: `b${++row}`, parentUuid: null, timestamp });
}

test('a transcript with no message yet is left unindexed until one is written', async () => {
    const path = join(dataDir, 'empty.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'permission-mode', mode: 'default' }) + '\n');

    assert.equal(await syncSession('empty', path), 0);
    assert.equal(sessionState('empty'), null);

    appendFileSync(path, [user('Rename the settings button to Save changes'), assistant('Renamed it in SettingsForm.')].join('\n') + '\n');

    assert.equal(await syncSession('empty', path), 3);
    assert.equal(sessionState('empty').lines, 3);
});

test('a sync appends only complete new lines', async () => {
    const path = join(dataDir, 'grow.jsonl');
    writeFileSync(path, [user('Use the staging database for the import'), assistant('Pointed the import at staging.')].join('\n') + '\n');
    await syncSession('grow', path);
    const before = store('sessions').document('grow').units.length;

    // The last line has no newline yet: it is still being written.
    appendFileSync(path, user('Also skip archived rows') + '\n' + assistant('Skipping archived rows.').slice(0, 40));

    assert.equal(await syncSession('grow', path), 1);
    assert.equal(sessionState('grow').lines, 3);
    assert.ok(store('sessions').document('grow').units.length > before);
});

test('a process maps to the session its latest SessionStart recorded, indexed or not', () => {
    assert.equal(sessionOfProcess(4242), null);

    recordProcessSession(4242, 'grow', join(dataDir, 'grow.jsonl'), '/work');
    assert.equal(sessionOfProcess(4242).lines, 3);

    // After a /clear the same process starts a session nothing has indexed yet.
    recordProcessSession(4242, 'cleared', join(dataDir, 'cleared.jsonl'), '/work');
    assert.deepEqual(sessionOfProcess(4242), { id: 'cleared', transcript: join(dataDir, 'cleared.jsonl'), cwd: '/work', project: projectOf(join(dataDir, 'cleared.jsonl')), lines: 0 });
});

test('the compaction time is the latest boundary row, not the marker inside another row', () => {
    // In message text the marker is escaped; inside a tool call's input it is not.
    const quoted = JSON.stringify({ type: 'assistant', uuid: `a${++row}`, timestamp: '2026-10-04T09:00:00.000Z', message: { id: `msg${row}`, role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'compact_boundary' } }] } });

    assert.equal(lastCompaction([user('hello'), quoted].join('\n') + '\n'), null);
    assert.equal(lastCompaction([user('hello'), boundary('2026-10-02T09:00:00.000Z'), quoted].join('\n') + '\n'), '2026-10-02T09:00:00.000Z');
    assert.equal(lastCompaction([boundary('2026-10-02T09:00:00.000Z'), user('x'), boundary('2026-10-03T09:00:00.000Z')].join('\n') + '\n'), '2026-10-03T09:00:00.000Z');
});

test('a session whose transcript is not written yet is skipped without an error', async () => {
    assert.equal(await syncSession('unwritten', join(dataDir, 'unwritten.jsonl')), 0);
    assert.equal(sessionState('unwritten'), null);
});

test('a compaction written after the last sync is found before the next prompt', async () => {
    const path = join(dataDir, 'late.jsonl');
    writeFileSync(path, [user('Keep the import on staging'), assistant('Using staging.')].join('\n') + '\n');
    await syncSession('late', path);
    appendFileSync(path, [boundary('2026-10-02T09:00:00.000Z'), user('Carry on')].join('\n') + '\n');

    // Past the compaction check, retrieval runs, and without a key it throws.
    await assert.rejects(passagesBeforeCompaction('late', 'Which database does the import use?'), /No Jev key/);
});

test('a session that was never compacted adds no passages to a prompt', async () => {
    assert.equal(await passagesBeforeCompaction('grow', 'Which database does the import use?'), null);
});

test('the processor reserves places for vector hits unless the user config says otherwise', () => {
    assert.equal(processor(null).config.nearestReserved, 3);

    const own = join(dataDir, 'config.json');
    writeFileSync(own, JSON.stringify({ nearest_reserved: 0 }));
    process.env.ATLAS_RECALL_CONFIG = own;
    try {
        assert.equal(processor(null).config.nearestReserved, 0);
    } finally {
        delete process.env.ATLAS_RECALL_CONFIG;
    }
});

test('every unit is embedded, tool calls and output included, without its speaker line', async () => {
    const requests = [];
    const fetch0 = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = 'test';
    globalThis.fetch = async (_url, init) => {
        const { input } = JSON.parse(init.body);
        requests.push(...input);
        return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    };

    try {
        await ensureVectors(dataDir, 'test', {
            id: 'tools',
            units: [
                { id: 'm1', kind: 'message', text: '[user, 2026-10-01T10:00:00Z]\nWhy is the import slow?' },
                { id: 'm2', kind: 'message', text: '[assistant, 2026-10-01T10:00:01Z]\nBash({"command":"time php artisan import"})' },
                { id: 'o1', kind: 'output', text: '[tool, 2026-10-01T10:00:02Z]\nreal 4m12s' },
            ],
        });
    } finally {
        globalThis.fetch = fetch0;
        delete process.env.OPENROUTER_API_KEY;
    }

    assert.deepEqual(requests, ['Why is the import slow?', 'Bash({"command":"time php artisan import"})', 'real 4m12s']);
});

test('the prompt hook skips short prompts and slash commands, and sessions never compacted', async () => {
    const compacted = join(dataDir, 'compacted.jsonl');
    writeFileSync(compacted, [user('Keep the import on staging'), assistant('Using staging.'), boundary('2026-10-02T09:00:00.000Z'), user('Carry on with the import')].join('\n') + '\n');
    await syncSession('compacted', compacted);
    const hook = (session, transcript, prompt) => spawnSync(process.execPath, [join(root, 'src/hook.mjs'), 'prompt'], { input: JSON.stringify({ session_id: session, transcript_path: transcript, prompt }), env, encoding: 'utf8' });
    const log = join(dataDir, 'errors.log');

    // Without a key, any prompt that gets past the gate tries to retrieve and logs the failure.
    for (const prompt of ['ok go', '/compact keep it short please, thanks']) {
        assert.equal(hook('compacted', compacted, prompt).stdout, '', prompt);
        assert.equal(existsSync(log), false, prompt);
    }
    assert.equal(hook('grow', join(dataDir, 'grow.jsonl'), 'Which database does the import read from?').stdout, '');
    assert.equal(existsSync(log), false);

    assert.equal(hook('compacted', compacted, 'Which database does the import read from?').stdout, '');
    assert.match(readFileSync(log, 'utf8'), /No Jev key/);
});

test('dist/ is the build of the current source', () => {
    const out = mkdtempSync(join(tmpdir(), 'atlas-recall-build-'));
    const build = spawnSync('npm', ['run', 'build', '--', `--outdir=${out}`], { cwd: root, encoding: 'utf8' });

    assert.equal(build.status, 0, build.stderr);
    for (const entry of ['hook.mjs', 'server.mjs']) {
        assert.ok(readFileSync(join(out, entry)).equals(readFileSync(join(root, 'dist', entry))), `dist/${entry} is out of date: run npm run build`);
    }
});
