# Episodic Memory

Semantic search system for Claude Code conversations. Archives conversations, generates local embeddings, indexes them in SQLite with vector search, and exposes them via MCP tools and CLI.

## Build & Test Commands

```bash
npm install                    # Install deps, rebuild better-sqlite3
npm run build                  # tsc + esbuild bundle
npm test                       # vitest run (single pass)
npm run test:watch             # vitest watch mode
```

## Project Structure

```
src/                           # Core TypeScript (ESM, strict mode)
├── types.ts                   # Core interfaces: ConversationExchange, SearchResult, ToolCall
├── paths.ts                   # Directory/path resolution (XDG, env var overrides)
├── parser.ts                  # JSONL → ConversationExchange[] (streaming readline)
├── embeddings.ts              # Transformers.js pipeline (nomic-embed-text-v1.5, 256-dim Matryoshka)
├── db.ts                      # SQLite schema, idempotent migrations, insert/query
├── search.ts                  # Vector + text search, multi-concept AND search
├── indexer.ts                 # Batch indexing with concurrency + summarization
├── sync.ts                    # Incremental copy from ~/.claude/projects → archive + index
├── summarizer.ts              # Claude API summarization (haiku, fallback sonnet)
├── mcp-server.ts              # MCP server: search + read tools (stdio transport)
├── show.ts                    # JSONL → readable markdown with metadata
├── verify.ts                  # Index integrity checks
├── stats.ts                   # Database statistics
├── *-cli.ts                   # CLI handlers for each subcommand
└── index.ts                   # Public API re-exports
cli/                           # Entry points (bash wrappers + Node.js dispatchers)
test/                          # Vitest tests
├── *.test.ts                  # Test suites (30s timeout for embedding tests)
├── fixtures/                  # JSONL test data (various sizes)
└── test-utils.ts              # createTestDb, suppressConsole, getFixturePath
.claude-plugin/                # Plugin manifest (agents, MCP servers)
agents/                        # Search agent prompt template
skills/                        # Claude Code skill definition
hooks/                         # SessionStart hook (sync --background)
```

## Code Conventions

- **ESM throughout** — `"type": "module"`, use `.js` extensions in all imports (even for `.ts` source)
- **TypeScript strict mode** — ES2022 target, ESNext modules
- **Async/await** for all I/O
- **Zod** for MCP tool input validation
- **Idempotent operations** — DB migrations check column existence, sync skips already-processed files
- **Atomic file writes** — temp file + rename pattern for conversation copies
- **Test pattern** — `createTestDb()` returns `{ db, cleanup }`, always call cleanup in finally block

## Key Architectural Details

- **Embeddings are local** — Transformers.js (@huggingface/transformers v3) with ONNX, no external API calls
- **Summarization uses Claude API** — configurable via `EPISODIC_MEMORY_API_*` env vars
- **SQLite + sqlite-vec** — WAL mode, FLOAT[256] vector column for k-NN search (Matryoshka-truncated)
- **Exchange IDs** — MD5 hash of archive path + line numbers (deterministic, dedup-safe)
- **MCP server is esbuild-bundled** — `dist/mcp-server.js` with externalized native deps

## Data Directories

```
~/.config/superpowers/
├── conversation-archive/      # Archived JSONL files (organized by project)
└── conversation-index/
    ├── db.sqlite              # Search index (exchanges + vec_exchanges + tool_calls)
    └── exclude.txt            # Projects to skip (one per line, # comments)
```

Override with: `EPISODIC_MEMORY_CONFIG_DIR`, `PERSONAL_SUPERPOWERS_DIR`, or `XDG_CONFIG_HOME`.

## Modify Carefully

- **db.ts schema/migrations** — migrations must be idempotent (check before ALTER)
- **MCP tool signatures** — external consumers depend on search/read tool shapes
- **CLI command interfaces** — documented --help flags are part of the public API
