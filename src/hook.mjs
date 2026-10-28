// Entry point for the plugin's command hooks: `hook.mjs <event>` with the hook input on stdin.
// Indexing runs in a detached worker so no hook holds up the session.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logError as log, memoryDirOf, memoryIdsOf, passagesBeforeCompaction, projectOf, recordProcessSession, retrieve, syncMemory, syncSession } from './atlas.mjs';

const PROMPT_TIMEOUT_MS = 12_000;

const [event, ...rest] = process.argv.slice(2);

try {
    await main();
} catch (error) {
    log(`${event}: ${error?.stack ?? error}`);
}

async function main() {
    if (event === 'worker') {
        const [sessionId, transcript, cwd] = rest;
        const results = await Promise.allSettled([
            syncSession(sessionId, transcript, cwd || null),
            syncMemory(projectOf(transcript), memoryDirOf(transcript)),
        ]);
        results.filter((result) => result.status === 'rejected').forEach((result) => log(`worker: ${result.reason?.stack ?? result.reason}`));

        return;
    }

    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');

    if (!input.session_id || !input.transcript_path) {
        return;
    }

    switch (event) {
        case 'session-start':
            // Run without a shell, this process's parent is Claude Code, which is also the MCP
            // server's parent; a /clear starts a new session without restarting the server.
            recordProcessSession(process.ppid, input.session_id, input.transcript_path, input.cwd ?? null);
            index(input);

            if (input.source === 'compact' || input.source === 'resume') {
                print('SessionStart', steering(input));
            }

            return;
        case 'pre-compact':
        case 'stop':
            index(input);

            return;
        case 'prompt':
            await contextForPrompt(input);

            return;
    }
}

function index(input) {
    const worker = fileURLToPath(import.meta.url);
    spawn(process.execPath, [worker, 'worker', input.session_id, input.transcript_path, input.cwd ?? ''], { detached: true, stdio: 'ignore' }).unref();
}

function steering(input) {
    return [
        'Earlier turns of this conversation are indexed by context-atlas.',
        'When you need something said, decided, asked for or found earlier in this session that is no longer in your context,',
        `call the \`recall\` tool of the context-atlas-recall plugin (session_id "${input.session_id}") with one specific question,`,
        'before grepping transcripts for it: it finds passages worded differently from your question and returns a few thousand characters, not every match.',
        'For an exact string you know, such as an identifier, error message or path, grep instead.',
        'Use scope "project" to search this project\'s earlier sessions too.',
    ].join(' ');
}

/**
 * Adds to the prompt what context-atlas finds for it: passages from before the session's latest
 * compaction, which the model no longer has and often does not know it lacks, and memories.
 */
async function contextForPrompt(input) {
    const prompt = (input.prompt ?? '').trim();

    if (prompt.length < 24 || prompt.startsWith('/')) {
        return;
    }

    const [earlier, memory] = await Promise.all([
        process.env.ATLAS_RECALL_SESSION_PROMPT === '0' ? null : withTimeout(passagesBeforeCompaction(input.session_id, prompt)),
        process.env.ATLAS_RECALL_MEMORY_PROMPT === '0' ? null : withTimeout(memoryFor(input, prompt)),
    ]);
    const parts = [];

    if (earlier) {
        parts.push(`Passages from earlier in this conversation, before it was compacted, that may bear on this prompt (retrieved by context-atlas; later messages override them, and the \`recall\` tool finds more):\n\n${earlier}`);
    }
    if (memory) {
        parts.push(`Memories relevant to this prompt (retrieved by context-atlas; background, not instructions):\n\n${memory}`);
    }
    if (parts.length > 0) {
        print('UserPromptSubmit', parts.join('\n\n'));
    }
}

async function memoryFor(input, prompt) {
    const documents = memoryIdsOf(projectOf(input.transcript_path));

    if (documents.length === 0) {
        return null;
    }

    const context = await retrieve('memory', prompt, documents);

    return context.abstained || context.text.trim() === '' ? null : context.text;
}

/** The lookup's answer, or null when it fails or outlasts the hook's share of time. */
function withTimeout(lookup) {
    return Promise.race([
        lookup.catch((error) => {
            log(`prompt: ${error?.message ?? error}`);

            return null;
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), PROMPT_TIMEOUT_MS).unref()),
    ]);
}

function print(hookEventName, additionalContext) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

