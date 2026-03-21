---
name: remembering-conversations
description: Use when user asks 'how should I...' or 'what's the best approach...' after exploring code, OR when you've tried to solve something and are stuck, OR for unfamiliar workflows, OR when user references past work. Searches conversation history.
---

# Remembering Conversations

**Core principle:** Search before reinventing. Searching costs nothing; reinventing or repeating mistakes costs everything.

## Triage: Direct Tool Call vs. Search Agent

### Simple lookups: Direct MCP tool call (fast, ~3 seconds)

For straightforward queries where you need a quick answer, call the search MCP tool directly:

```
mcp__plugin_episodic-memory_episodic-memory__search
  query: "your search query"
  limit: 5
```

Results include conversation summaries by default, giving you enough context without reading full conversations.

**Use direct search for:**
- "Where did we leave off on X?"
- "Have we worked on X before?"
- "What was the approach for X?"
- Quick context checks before starting work
- Simple factual lookups

### Complex synthesis: Dispatch search agent (thorough, ~30-60 seconds)

For queries requiring reading multiple conversations and synthesizing insights, dispatch the search-conversations agent:

```
Task tool:
  description: "Search past conversations for [topic]"
  prompt: "Search for [specific query or topic]. Focus on [what you're looking for - e.g., decisions, patterns, gotchas, code examples]."
  subagent_type: "episodic-memory:search-conversations"
```

The agent will:
1. Search with the `search` tool
2. Read top 2-5 results with the `read` tool
3. Synthesize findings (200-1000 words)
4. Return actionable insights + sources

**Use the agent for:**
- Multi-faceted research across several conversations
- Understanding the evolution of a decision over time
- Comparing different approaches tried in different sessions
- Deep-dive into complex technical decisions
- When direct search results aren't sufficient

## When to Use

You often get value out of consulting your episodic memory once you understand what you're being asked. Search memory in these situations:

**After understanding the task:**
- User asks "how should I..." or "what's the best approach..."
- You've explored current codebase and need to make architectural decisions
- User asks for implementation approach after describing what they want

**When you're stuck:**
- You've investigated a problem and can't find the solution
- Facing a complex problem without obvious solution in current code
- Need to follow an unfamiliar workflow or process

**When historical signals are present:**
- User says "last time", "before", "we discussed", "you implemented"
- User asks "why did we...", "what was the reason..."
- User says "do you remember...", "what do we know about..."

**Don't search first:**
- For current codebase structure (use Grep/Read to explore first)
- For info in current conversation
- Before understanding what you're being asked to do

## API Reference

See MCP-TOOLS.md for complete API reference including search modes, date filtering, multi-concept search, and response formats.
