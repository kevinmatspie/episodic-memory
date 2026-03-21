import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
export declare function migrateSchema(db: Database.Database): void;
export declare function initDatabase(): Database.Database;
export declare function insertExchange(db: Database.Database, exchange: ConversationExchange, embedding: number[], toolNames?: string[]): void;
export declare function getAllExchanges(db: Database.Database): Array<{
    id: string;
    archivePath: string;
}>;
export declare function getFileLastIndexed(db: Database.Database, archivePath: string): number | null;
export declare function deleteExchange(db: Database.Database, id: string): void;
export declare function upsertSummary(db: Database.Database, archivePath: string, summary: string): void;
export declare function getSummary(db: Database.Database, archivePath: string): string | null;
export declare function getSummariesBatch(db: Database.Database, archivePaths: string[]): Map<string, string>;
export declare function migrateSummariesToDb(db: Database.Database): void;
