/**
 * Marker text that identifies summarizer agent conversations.
 * When this text appears in a conversation, it will be excluded from indexing.
 * Used in summarizer prompts to prevent agent conversations from polluting search results.
 */
export const SUMMARIZER_CONTEXT_MARKER =
  'Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant';

/** Embedding model identifier for Transformers.js pipeline */
export const EMBEDDING_MODEL = 'nomic-ai/nomic-embed-text-v1.5';

/** Output dimension after Matryoshka truncation (nomic-v1.5 native: 768) */
export const EMBEDDING_DIM = 256;
