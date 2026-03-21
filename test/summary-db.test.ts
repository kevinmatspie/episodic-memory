import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { upsertSummary, getSummary, getSummariesBatch, migrateSummariesToDb } from '../src/db.js';
import { suppressConsole } from './test-utils.js';

function createTestDbWithSchema(): { db: Database.Database; tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-memory-summary-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      archive_path TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const cleanup = () => {
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  };

  return { db, tmpDir, cleanup };
}

describe('conversation_summaries', () => {
  let db: Database.Database;
  let tmpDir: string;
  let cleanup: () => void;
  let restoreConsole: () => void;

  beforeEach(() => {
    ({ db, tmpDir, cleanup } = createTestDbWithSchema());
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    cleanup();
  });

  describe('upsertSummary', () => {
    it('should insert a new summary', () => {
      upsertSummary(db, '/path/to/conv.jsonl', 'Test summary');
      const result = getSummary(db, '/path/to/conv.jsonl');
      expect(result).toBe('Test summary');
    });

    it('should update an existing summary', () => {
      upsertSummary(db, '/path/to/conv.jsonl', 'First summary');
      upsertSummary(db, '/path/to/conv.jsonl', 'Updated summary');
      const result = getSummary(db, '/path/to/conv.jsonl');
      expect(result).toBe('Updated summary');
    });
  });

  describe('getSummary', () => {
    it('should return null for non-existent path', () => {
      const result = getSummary(db, '/path/does/not/exist.jsonl');
      expect(result).toBeNull();
    });
  });

  describe('getSummariesBatch', () => {
    it('should return summaries for multiple paths', () => {
      upsertSummary(db, '/path/a.jsonl', 'Summary A');
      upsertSummary(db, '/path/b.jsonl', 'Summary B');
      upsertSummary(db, '/path/c.jsonl', 'Summary C');

      const result = getSummariesBatch(db, ['/path/a.jsonl', '/path/c.jsonl']);
      expect(result.size).toBe(2);
      expect(result.get('/path/a.jsonl')).toBe('Summary A');
      expect(result.get('/path/c.jsonl')).toBe('Summary C');
    });

    it('should handle empty array', () => {
      const result = getSummariesBatch(db, []);
      expect(result.size).toBe(0);
    });

    it('should skip non-existent paths', () => {
      upsertSummary(db, '/path/a.jsonl', 'Summary A');
      const result = getSummariesBatch(db, ['/path/a.jsonl', '/path/missing.jsonl']);
      expect(result.size).toBe(1);
      expect(result.get('/path/a.jsonl')).toBe('Summary A');
    });
  });

  describe('migrateSummariesToDb', () => {
    it('should migrate .summary files to DB', () => {
      // Create a fake archive file and summary
      const archivePath = path.join(tmpDir, 'conv.jsonl');
      const summaryPath = path.join(tmpDir, 'conv-summary.txt');
      fs.writeFileSync(archivePath, '{}', 'utf-8');
      fs.writeFileSync(summaryPath, 'Migrated summary content', 'utf-8');

      // Insert an exchange referencing this archive path
      db.prepare(
        'INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('ex1', 'test', '2024-01-01', 'hello', 'hi', archivePath, 1, 2);

      migrateSummariesToDb(db);

      const result = getSummary(db, archivePath);
      expect(result).toBe('Migrated summary content');
    });

    it('should skip migration if summaries already exist in DB', () => {
      const archivePath = path.join(tmpDir, 'conv.jsonl');
      fs.writeFileSync(archivePath, '{}', 'utf-8');

      db.prepare(
        'INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('ex1', 'test', '2024-01-01', 'hello', 'hi', archivePath, 1, 2);

      // Pre-populate DB summary
      upsertSummary(db, archivePath, 'Existing DB summary');

      // Create a different summary file
      const summaryPath = path.join(tmpDir, 'conv-summary.txt');
      fs.writeFileSync(summaryPath, 'File summary that should NOT overwrite', 'utf-8');

      migrateSummariesToDb(db);

      // Should keep the existing DB summary, not overwrite
      const result = getSummary(db, archivePath);
      expect(result).toBe('Existing DB summary');
    });

    it('should handle missing summary files gracefully', () => {
      const archivePath = path.join(tmpDir, 'conv.jsonl');
      fs.writeFileSync(archivePath, '{}', 'utf-8');

      db.prepare(
        'INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('ex1', 'test', '2024-01-01', 'hello', 'hi', archivePath, 1, 2);

      // No summary file exists — should not throw
      migrateSummariesToDb(db);

      const result = getSummary(db, archivePath);
      expect(result).toBeNull();
    });
  });
});
