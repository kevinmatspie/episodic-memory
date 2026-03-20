import { pipeline } from '@huggingface/transformers';
import { EMBEDDING_DIM, EMBEDDING_MODEL } from './constants.js';
let embeddingPipeline = null;
export async function initEmbeddings() {
    if (!embeddingPipeline) {
        console.log('Loading embedding model (first run may take time)...');
        // @ts-expect-error — pipeline() overloads produce a union too complex for TS
        embeddingPipeline = await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' });
        console.log('Embedding model loaded');
    }
}
export async function generateEmbedding(text, options = {}) {
    if (!embeddingPipeline) {
        await initEmbeddings();
    }
    // Add task prefix required by nomic-embed-text-v1.5
    const prefix = options.isQuery ? 'search_query: ' : 'search_document: ';
    // Truncate text to stay within token budget (nomic supports 8192 tokens)
    const truncated = text.substring(0, 8000);
    const prefixed = prefix + truncated;
    const output = await embeddingPipeline(prefixed, {
        pooling: 'mean',
        normalize: true
    });
    // Matryoshka truncation: slice to target dimension and re-normalize
    const fullEmbedding = Array.from(output.data);
    const truncatedEmbedding = fullEmbedding.slice(0, EMBEDDING_DIM);
    // Re-normalize after truncation (the pipeline normalized the full 768-dim vector,
    // but slicing breaks unit length — cosine similarity requires re-normalization)
    const norm = Math.sqrt(truncatedEmbedding.reduce((sum, x) => sum + x * x, 0));
    if (norm > 0) {
        for (let i = 0; i < truncatedEmbedding.length; i++) {
            truncatedEmbedding[i] /= norm;
        }
    }
    return truncatedEmbedding;
}
export async function generateExchangeEmbedding(userMessage, assistantMessage, toolNames) {
    // Combine user question, assistant answer, and tools used for better searchability
    let combined = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;
    // Include tool names in embedding for tool-based searches
    if (toolNames && toolNames.length > 0) {
        combined += `\n\nTools: ${toolNames.join(', ')}`;
    }
    return generateEmbedding(combined);
}
