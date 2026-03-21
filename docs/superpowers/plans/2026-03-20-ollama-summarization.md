# Ollama Summarization Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ollama as a configurable local-model backend for conversation summarization, so users can summarize without Claude API credits.

**Architecture:** Add a `callOllama` function that uses `fetch` to call Ollama's OpenAI-compatible `/v1/chat/completions` endpoint. A `callLLM` dispatcher reads `EPISODIC_MEMORY_SUMMARIZER_PROVIDER` env var to route to either `callClaude` (existing, untouched) or `callOllama`. The Claude path retains its fallback model behavior; Ollama uses a single model.

**Tech Stack:** Node.js native `fetch`, Ollama OpenAI-compatible API, vitest for testing.

---

## File Structure

- **Modify:** `src/summarizer.ts` — add `callOllama`, `callLLM` dispatcher, new env var readers
- **Modify:** `.env` — add commented-out Ollama config examples
- **Create:** `test/ollama-summarizer.test.ts` — unit tests for Ollama provider logic

---

### Task 1: Add `callOllama` function with tests

**Files:**
- Create: `test/ollama-summarizer.test.ts`
- Modify: `src/summarizer.ts`

- [ ] **Step 1: Write the failing test for `callOllama`**

Create `test/ollama-summarizer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We'll test callOllama via the exported callLLM once it exists.
// For now, test the Ollama HTTP call logic in isolation.

describe('Ollama summarization', () => {
  beforeEach(() => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_PROVIDER = 'ollama';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'llama3.1:8b';
  });

  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_PROVIDER;
    delete process.env.EPISODIC_MEMORY_OLLAMA_MODEL;
    delete process.env.EPISODIC_MEMORY_OLLAMA_BASE_URL;
    vi.restoreAllMocks();
  });

  it('should call Ollama OpenAI-compatible endpoint with correct payload', async () => {
    const mockResponse = {
      choices: [{ message: { content: '<summary>Test summary</summary>' } }]
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    // Import after env is set
    const { callOllama } = await import('../src/summarizer.js');
    const result = await callOllama('Summarize this conversation');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');

    const body = JSON.parse(options!.body as string);
    expect(body.model).toBe('llama3.1:8b');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('Summarize this conversation');

    expect(result).toBe('Test summary');
  });

  it('should use custom base URL when configured', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_BASE_URL = 'http://gpu-box:11434';

    const mockResponse = {
      choices: [{ message: { content: '<summary>Test</summary>' } }]
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const { callOllama } = await import('../src/summarizer.js');
    await callOllama('test prompt');

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://gpu-box:11434/v1/chat/completions');
  });

  it('should throw clear error when Ollama is not reachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed')
    );

    const { callOllama } = await import('../src/summarizer.js');
    await expect(callOllama('test')).rejects.toThrow(
      /Ollama not reachable at http:\/\/localhost:11434/
    );
  });

  it('should throw on non-OK HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'model not found',
    } as Response);

    const { callOllama } = await import('../src/summarizer.js');
    await expect(callOllama('test')).rejects.toThrow(/Ollama error 500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/ollama-summarizer.test.ts`
Expected: FAIL — `callOllama` is not exported from `summarizer.js`

- [ ] **Step 3: Implement `callOllama` in `src/summarizer.ts`**

Add these functions to `src/summarizer.ts`:

```typescript
function getOllamaConfig() {
  return {
    baseUrl: process.env.EPISODIC_MEMORY_OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.EPISODIC_MEMORY_OLLAMA_MODEL || 'llama3.1:8b',
  };
}

export async function callOllama(prompt: string): Promise<string> {
  const { baseUrl, model } = getOllamaConfig();
  const url = `${baseUrl}/v1/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'Write concise, factual summaries. Output ONLY the summary - no preamble, no "Here is", no "I will". Your output will be indexed directly.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
      }),
    });
  } catch (error) {
    throw new Error(`Ollama not reachable at ${baseUrl} — is it running? (${error})`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  return extractSummary(content);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/ollama-summarizer.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/summarizer.ts test/ollama-summarizer.test.ts
git commit -m "feat: Add callOllama function for local model summarization"
```

---

### Task 2: Add `callLLM` dispatcher and wire it up

**Files:**
- Modify: `src/summarizer.ts`
- Modify: `test/ollama-summarizer.test.ts`

- [ ] **Step 1: Write the failing test for provider dispatch**

Append to `test/ollama-summarizer.test.ts`:

```typescript
describe('Provider dispatch', () => {
  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_PROVIDER;
    vi.restoreAllMocks();
  });

  it('should default to claude provider when env var is not set', async () => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_PROVIDER;
    const { getSummarizerProvider } = await import('../src/summarizer.js');
    expect(getSummarizerProvider()).toBe('claude');
  });

  it('should return ollama when configured', async () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_PROVIDER = 'ollama';
    const { getSummarizerProvider } = await import('../src/summarizer.js');
    expect(getSummarizerProvider()).toBe('ollama');
  });

  it('should throw on unknown provider', async () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_PROVIDER = 'unknown';
    const { getSummarizerProvider } = await import('../src/summarizer.js');
    expect(() => getSummarizerProvider()).toThrow(/Unknown summarizer provider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/ollama-summarizer.test.ts`
Expected: FAIL — `getSummarizerProvider` is not exported

- [ ] **Step 3: Implement dispatcher in `src/summarizer.ts`**

Add:

```typescript
export function getSummarizerProvider(): 'claude' | 'ollama' {
  const provider = process.env.EPISODIC_MEMORY_SUMMARIZER_PROVIDER || 'claude';
  if (provider !== 'claude' && provider !== 'ollama') {
    throw new Error(`Unknown summarizer provider: "${provider}". Use "claude" or "ollama".`);
  }
  return provider;
}
```

Then replace both call sites of `callClaude(prompt)` (in `summarizeConversation` — the short-conversation path and the chunk/synthesis paths) with a `callLLM` helper:

```typescript
async function callLLM(prompt: string, sessionId?: string, useFallback?: boolean): Promise<string> {
  if (getSummarizerProvider() === 'ollama') {
    return callOllama(prompt);
  }
  return callClaude(prompt, sessionId, useFallback);
}
```

Replace `callClaude(prompt, sessionId)` → `callLLM(prompt, sessionId)` and `callClaude(prompt)` → `callLLM(prompt)` in `summarizeConversation`.

- [ ] **Step 4: Run ALL tests to verify nothing broke**

Run: `npm test`
Expected: All existing tests PASS, all new tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/summarizer.ts test/ollama-summarizer.test.ts
git commit -m "feat: Add provider dispatch to route summarization to Claude or Ollama"
```

---

### Task 3: Update `.env` and build

**Files:**
- Modify: `.env`
- Modify: `src/summarizer.ts` (only if build reveals issues)

- [ ] **Step 1: Add Ollama config examples to `.env`**

Append to `.env`:

```bash

# Summarizer provider: "claude" (default) or "ollama" (local model)
# EPISODIC_MEMORY_SUMMARIZER_PROVIDER=ollama

# Ollama settings (only used when provider=ollama)
# EPISODIC_MEMORY_OLLAMA_MODEL=llama3.1:8b
# EPISODIC_MEMORY_OLLAMA_BASE_URL=http://localhost:11434
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add .env src/summarizer.ts
git commit -m "feat: Add Ollama configuration to .env"
```

---

### Task 4: Manual smoke test with Ollama

- [ ] **Step 1: Enable Ollama in `.env`**

Temporarily set:
```bash
EPISODIC_MEMORY_SUMMARIZER_PROVIDER=ollama
EPISODIC_MEMORY_OLLAMA_MODEL=llama3.1:8b
```

- [ ] **Step 2: Run sync and verify Ollama is called**

Run: `node cli/episodic-memory.js sync`
Expected: Sync runs, summaries are generated by Ollama (no API errors, no Claude calls)

- [ ] **Step 3: Verify summary quality**

Check a few generated summaries look reasonable — they should be 2-4 sentences describing what happened in the conversation.

- [ ] **Step 4: Revert `.env` or leave as preferred**

Set provider back to `claude` if desired, or leave as `ollama`.
