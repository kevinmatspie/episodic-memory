import { describe, it, expect, vi, afterEach } from 'vitest';
import { callOllama } from '../src/summarizer.js';

describe('Ollama summarization', () => {
  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_OLLAMA_MODEL;
    delete process.env.EPISODIC_MEMORY_OLLAMA_BASE_URL;
    vi.restoreAllMocks();
  });

  it('should call Ollama OpenAI-compatible endpoint with correct payload', async () => {
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'llama3.1:8b';

    const mockResponse = {
      choices: [{ message: { content: '<summary>Test summary</summary>' } }]
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

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

    await callOllama('test prompt');

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://gpu-box:11434/v1/chat/completions');
  });

  it('should throw clear error when Ollama is not reachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed')
    );

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

    await expect(callOllama('test')).rejects.toThrow(/Ollama error 500/);
  });
});
