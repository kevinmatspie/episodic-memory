import { ConversationExchange } from './types.js';
export declare function formatConversationText(exchanges: ConversationExchange[]): string;
export declare function callOllama(prompt: string): Promise<string>;
export declare function getSummarizerProvider(): 'claude' | 'ollama';
export declare function summarizeConversation(exchanges: ConversationExchange[], sessionId?: string): Promise<string>;
