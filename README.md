# Episodic Memory

Semantic search for Claude Code conversations. Remember past discussions, decisions, and patterns across projects and sessions.

> Forked from [obra/episodic-memory](https://github.com/obra/episodic-memory) by Jesse Vincent. This fork adds an upgraded embedding model, FTS5 full-text search, Ollama summarization, and other improvements.

## Why Episodic Memory?

Claude Code's built-in memory is per-project and curated. Episodic memory gives you full-fidelity, cross-project recall — the ability to say "implement this like we did in project Y" and have Claude actually find that conversation, understand the approach, and apply it.

What it preserves that nothing else does:
- **Trade-offs discussed** — why you chose approach A over B
- **Alternatives rejected** — what you tried and abandoned
- **Architectural patterns** — how you solved similar problems before
- **Project evolution** — the journey, not just the destination

## Installation

### As a Claude Code Plugin (Recommended)

**Option A: Install from GitHub**

In any Claude Code session:

```
/plugin marketplace add kevinmatspie/episodic-memory
/plugin install episodic-memory@episodic-memory
```

**Option B: Install from a local clone**

```bash
# Clone and build
git clone git@github.com:kevinmatspie/episodic-memory.git
cd episodic-memory
npm install && npm run build
```

Then in Claude Code:

```
/plugin marketplace add /path/to/episodic-memory
/plugin install episodic-memory@episodic-memory
```

**Option C: Settings-based (persistent across sessions)**

Add to your `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "episodic-memory": {
      "source": {
        "source": "github",
        "repo": "kevinmatspie/episodic-memory"
      }
    }
  },
  "enabledPlugins": {
    "episodic-memory@episodic-memory": true
  }
}
```

For a local clone, use `"source": "directory"` with a `"path"` instead.

**What the plugin provides:**
- SessionStart hook that syncs and indexes conversations in the background
- MCP server with `search` and `read` tools
- Search agent for guided conversation recall

## Quick Start

```bash
# Sync conversations from Claude Code and index them
episodic-memory sync

# Search your conversation history
episodic-memory search "authentication architecture"

# Multi-concept AND search
episodic-memory search "React Router" "JWT" "middleware"

# View index statistics
episodic-memory stats

# Display a conversation
episodic-memory show path/to/conversation.jsonl
```

## How It Works

1. **Sync** — Copies conversation files from `~/.claude/projects` to a permanent archive
2. **Parse** — Extracts user-assistant exchanges from JSONL, linking tool results to their tool calls
3. **Embed** — Generates 256-dim vector embeddings locally using nomic-embed-text-v1.5 (Matryoshka truncation from 768-dim, 8K token context)
4. **Summarize** — Generates conversation summaries via Ollama (local) or Claude API
5. **Index** — Stores in SQLite with sqlite-vec for vector search, FTS5 for full-text search with porter stemming
6. **Search** — Combined semantic + full-text search with ranked results

### What Runs Where

| Component | Local or Remote |
|-----------|-----------------|
| Embeddings | Local — Transformers.js, nomic-embed-text-v1.5 (q8 quantized ONNX) |
| Text search | Local — SQLite FTS5 with porter stemming |
| Vector search | Local — SQLite sqlite-vec, 256-dim cosine similarity |
| Summarization | Local (Ollama) or Remote (Claude API) |
| MCP tools | Local — stdio transport |

## Commands

### `episodic-memory sync`

**Primary command.** Copies new conversations from `~/.claude/projects` to archive and indexes them. The SessionStart hook runs this automatically in the background.

- Only copies new or modified files (fast on subsequent runs)
- Generates embeddings for semantic search
- Atomic operations — safe to run concurrently
- Idempotent — safe to call repeatedly

**Automatic syncing with cron:**

The SessionStart hook indexes when Claude Code starts, but a cron job keeps the index fresh during long sessions. Example crontab entry to sync every 15 minutes:

```bash
# Edit your crontab
crontab -e

# Add this line (adjust the path to your clone):
*/15 * * * * cd /path/to/episodic-memory && /usr/local/bin/node cli/episodic-memory.js sync >> /tmp/episodic-memory-sync.log 2>&1
```

Use `which node` to find your Node.js path — on Apple Silicon Macs with Homebrew it's typically `/opt/homebrew/bin/node`.

### `episodic-memory search`

Search indexed conversations using semantic similarity, full-text matching, or both.

```bash
episodic-memory search "query"                    # Combined vector + text (default)
episodic-memory search --vector "query"            # Semantic only
episodic-memory search --text "exact phrase"       # FTS5 text only
episodic-memory search --after 2025-09-01 "query"  # Date filtering
episodic-memory search "concept1" "concept2"       # Multi-concept AND search
```

### `episodic-memory index`

Manual indexing tools for bulk operations and maintenance.

```bash
episodic-memory index --cleanup     # Index all unprocessed conversations
episodic-memory index --verify      # Check index health
episodic-memory index --repair      # Fix detected issues
episodic-memory index --rebuild     # Delete DB and re-index everything
episodic-memory index --verbose     # Show per-conversation progress
episodic-memory index --no-summaries  # Skip AI summarization
```

### `episodic-memory show`

Display a conversation from a JSONL file in readable format.

```bash
episodic-memory show conversation.jsonl                    # Markdown (default)
episodic-memory show --format html conversation.jsonl > out.html  # HTML for browser
```

### `episodic-memory stats`

Display index statistics — conversation counts, date ranges, project breakdown.

## Summarization Configuration

Summarization can use a local Ollama model or the Claude API.

### Ollama (Recommended — Fully Local)

```bash
# In your .env file
EPISODIC_MEMORY_SUMMARIZER_PROVIDER=ollama
EPISODIC_MEMORY_OLLAMA_MODEL=llama3.1:8b
# EPISODIC_MEMORY_OLLAMA_BASE_URL=http://localhost:11434  # default
```

### Claude API

```bash
# In your .env file
EPISODIC_MEMORY_SUMMARIZER_PROVIDER=claude  # default if not set
EPISODIC_MEMORY_API_MODEL=haiku
EPISODIC_MEMORY_API_MODEL_FALLBACK=sonnet
# EPISODIC_MEMORY_API_BASE_URL=https://your-endpoint.com/api/anthropic
# EPISODIC_MEMORY_API_TOKEN=your-token
# EPISODIC_MEMORY_API_TIMEOUT_MS=3000000
```

## Excluding Conversations

Conversations containing this marker will be archived but not indexed:

```
<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>
```

Automatic exclusions:
- Conversations where Claude generates summaries (marker in system prompt)
- Meta-conversations about conversation processing

You can also exclude entire projects:
```bash
echo "project-name" >> ~/.config/superpowers/conversation-index/exclude.txt
```

## MCP Server

When installed as a Claude Code plugin, episodic-memory provides an MCP server with two tools:

### `search`

Search indexed conversations. Accepts a string (single query) or array of strings (multi-concept AND search).

```json
{
  "query": "authentication architecture",
  "mode": "both",
  "limit": 10,
  "after": "2025-01-01"
}
```

### `read`

Display a full conversation in readable markdown, with optional line-range pagination.

```json
{
  "path": "/path/to/conversation.jsonl",
  "startLine": 1,
  "endLine": 50
}
```

The MCP server can also be used standalone: `episodic-memory-mcp-server`

## Data Directories

```
~/.config/superpowers/
├── conversation-archive/      # Archived JSONL files (organized by project)
└── conversation-index/
    ├── db.sqlite              # Search index
    └── exclude.txt            # Projects to skip
```

Override with: `EPISODIC_MEMORY_CONFIG_DIR`, `PERSONAL_SUPERPOWERS_DIR`, or `XDG_CONFIG_HOME`.

## Development

```bash
npm install          # Install deps, rebuild better-sqlite3
npm run build        # tsc + esbuild bundle
npm test             # vitest (single pass)
npm run test:watch   # vitest watch mode
```

## Changes from Upstream

Key differences from [obra/episodic-memory](https://github.com/obra/episodic-memory):

- **Embedding model** — nomic-embed-text-v1.5 with Matryoshka truncation (256-dim) replaces all-MiniLM-L6-v2 (384-dim). Better retrieval quality, larger context window (8K vs 256 tokens), smaller storage.
- **FTS5 full-text search** — Porter-stemmed full-text search replaces LIKE queries. Falls back to LIKE if FTS5 query fails.
- **Ollama summarization** — Local summarization option via Ollama, in addition to Claude API.
- **Summaries in SQLite** — Conversation summaries stored in the database instead of separate text files.
- **Similarity score clamping** — Scores clamped to 0-1 range for consistent display.
- **Verbose indexing** — `--verbose` flag for per-conversation progress output.
- **@huggingface/transformers v3** — Upgraded from legacy @xenova/transformers v2.

## License

MIT — see [LICENSE](LICENSE) for details.
