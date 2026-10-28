# context-atlas-recall

A Claude Code plugin for token-efficient retrieval from a thread after compaction. It indexes the conversation,
the project's memory files, and large documents with [context-atlas](https://github.com/Fox-Islam/context-atlas),
then after a compaction allows Claude to semantically search for relevant information.

## Install

At a Claude Code prompt:

```
/plugin install context-atlas-recall --marketplace Fox-Islam/context-atlas-recall
```

Set these in the environment Claude Code starts in, or under `env` in `~/.claude/settings.json`:
- Jev, for retrieval: `TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY` with `TYPESAFE_PROVIDER=openrouter`
- Embeddings: `OPENROUTER_API_KEY`

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `ATLAS_RECALL_DIR` | `~/.claude/context-atlas-recall` | Where stores, sync state and `errors.log` live |
| `ATLAS_RECALL_CONFIG` | none | A JSON file of context-atlas config keys, such as `{"conversation_replies": false}` to cut Jev requests at indexing |
| `ATLAS_RECALL_SESSION_PROMPT` | on | `0` turns off adding pre-compaction passages to each prompt |
| `ATLAS_RECALL_MEMORY_PROMPT` | on | `0` turns off memory retrieval on each prompt |
| `ATLAS_RECALL_VECTORS` | on with an OpenRouter key | `0` turns off embeddings; search is then exact-term only |
| `ATLAS_RECALL_EMBED_MODEL` | `openai/text-embedding-3-small` | Any model the endpoint serves; changing it re-embeds on the next sync |
| `ATLAS_RECALL_EMBED_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible `/embeddings` base URL |

The `autoCompactWindow` setting, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, sets how often a session
compacts. A smaller window keeps every request's context smaller at the price of more
compactions (which may adversely affect response quality - configure for your model choice+use-case)

Keep rules that must be adhered to in CLAUDE.md or memory.

## Components

| Piece | What it does |
| --- | --- |
| `SessionStart`, `Stop`, `PreCompact` hooks | Index the session transcript and the project's `memory/*.md` in a detached worker: the whole transcript once, then only new lines through `append()` |
| `UserPromptSubmit` hook | Adds the passages from before the session's latest compaction, and the memory passages, relevant to the prompt. Skips prompts under 24 characters and slash commands, and gives up after 12s |
| `SessionStart` after a compaction or resume | Tells Claude to call `recall` for earlier context and to grep only for exact strings |
| `recall(query, session_id?, scope?)` | Passages of this session, or of every session of the project with `scope: "project"`, that answer the question. Indexes unindexed lines first |
| `recall_memory(query)` | Passages of this project's memory files |
| `read_relevant(path, question)` | The part of a large document, log or data file that answers the question. Indexes the file on first use and again when it changes |

## Limits

- Embeddings add about 0.6s to each `recall` and to each prompt's lookups, which take 1–2s in all
  after a compaction.
- The first index of a long session runs in the background and takes time: a 14,500-line
  transcript takes about 9 minutes and 1,300 Jev requests. Meanwhile `recall` waits up to 2
  minutes for the index, then searches whatever is stored, and the prompt hook adds nothing.
- Hooks never fail the session. Indexing errors go to `errors.log` in the data directory.
- `recall` without `session_id` searches the session Claude Code is running, after a `/clear`
  too: the `SessionStart` hook records the session under the Claude Code process, which is also
  the MCP server's parent. This needs the hooks' exec form in `hooks/hooks.json`, which runs them
  without a shell in between.
- `read_relevant` reads prose, markup, transcripts and spreadsheets, not source code.

## Development

`claude --plugin-dir .` loads the working copy for one session. `npm install && npm run build`
bundles `src/` into `dist/`, which is committed so an installed plugin needs no `npm install`.
`npm test` runs the tests, which need no keys or network and check that `dist/` matches the
source.
