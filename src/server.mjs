// MCP server exposing context-atlas retrieval over the conversation, memory and large files.
import { isAbsolute, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureFile, isReadable, memoryIdsOf, retrieve, sessionOfProcess, sessionState, sessionsOf, syncSession } from './atlas.mjs';

const server = new McpServer({ name: 'atlas', version: '0.1.0' });

server.registerTool('recall', {
    description: [
        'Retrieves the passages of this Claude Code conversation that answer a question, including turns lost to compaction:',
        'what the user asked for, decisions and corrections, tool calls and their output.',
        'Use it instead of grepping files or transcripts when you need earlier context. Ask one specific question per call.',
    ].join(' '),
    inputSchema: {
        query: z.string().describe('A specific question, e.g. "Which config key did the user say to rename?"'),
        session_id: z.string().optional().describe('The session to search; defaults to this session.'),
        scope: z.enum(['session', 'project']).optional().describe('"project" searches every indexed session of this project. Default "session".'),
    },
}, async ({ query, session_id, scope = 'session' }) => run(async () => {
    const session = session_id ? sessionState(session_id) : currentSession();

    if (session === null) {
        return 'No indexed session found. The index is built by the plugin\'s hooks as the conversation runs.';
    }

    await syncSession(session.id, session.transcript, session.cwd);

    const documents = scope === 'project' ? sessionsOf(session.project).map((state) => state.id) : [session.id];

    return answer(await retrieve('sessions', query, documents), 'Nothing in the indexed conversation answers that.');
}));

server.registerTool('recall_memory', {
    description: 'Retrieves the parts of this project\'s Claude Code memory files that answer a question.',
    inputSchema: { query: z.string() },
}, async ({ query }) => run(async () => {
    const session = currentSession();
    const documents = session === null ? [] : memoryIdsOf(session.project);

    if (documents.length === 0) {
        return 'No memory files are indexed for this project.';
    }

    return answer(await retrieve('memory', query, documents), 'No memory answers that.');
}));

server.registerTool('read_relevant', {
    description: [
        'Returns the few hundred tokens of a large document, log, transcript or data file (Markdown, HTML, text, JSON, YAML, CSV, XLSX, DOCX and more)',
        'that answer a question, instead of reading the whole file. Not for source code. The first call on a file indexes it,',
        'which takes seconds to minutes for a long file; later calls on the unchanged file are fast.',
    ].join(' '),
    inputSchema: {
        path: z.string().describe('Absolute path, or relative to the project directory.'),
        question: z.string(),
    },
}, async ({ path, question }) => run(async () => {
    const full = isAbsolute(path) ? path : resolve(process.cwd(), path);

    if (!isReadable(full)) {
        throw new Error(`Not a readable file: ${full}`);
    }

    return answer(await retrieve('files', question, [await ensureFile(full)]), 'Nothing in the file answers that.');
}));

await server.connect(new StdioServerTransport());

function answer(context, none) {
    if (context.abstained || context.text.trim() === '') {
        return none;
    }

    return context.text;
}

async function run(work) {
    try {
        return { content: [{ type: 'text', text: await work() }] };
    } catch (error) {
        return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
    }
}

/**
 * The session Claude Code is running: the one its last SessionStart recorded for this server's
 * parent process, else the `CLAUDE_CODE_SESSION_ID` the server started with, which a /clear does
 * not update, else the latest indexed session.
 */
function currentSession() {
    const own = process.env.CLAUDE_CODE_SESSION_ID;

    return sessionOfProcess(process.ppid) ?? (own ? sessionState(own) : null) ?? latestSession();
}

/** The most recently indexed session of the project the server was started in, else of any project. */
function latestSession() {
    return sessionsOf(process.cwd().replace(/[^A-Za-z0-9]/g, '-'))[0] ?? sessionsOf(null)[0] ?? null;
}
