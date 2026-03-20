export declare function initEmbeddings(): Promise<void>;
export interface EmbeddingOptions {
    isQuery?: boolean;
}
export declare function generateEmbedding(text: string, options?: EmbeddingOptions): Promise<number[]>;
export declare function generateExchangeEmbedding(userMessage: string, assistantMessage: string, toolNames?: string[]): Promise<number[]>;
