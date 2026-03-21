import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { insertExchange, deleteExchange, migrateFtsIndex } from '../src/db.js';
import { sanitizeFtsQuery } from '../src/search.js';
import { ConversationExchange } from '../src/types.js';
import { suppressConsole } from './test-utils.js';
import { EMBEDDING_DIM } from '../src/constants.js';

function createTestDbWithSchema(): { db: Database.Database; tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodic-memory-fts5-test-'));
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
      line_end INTEGER NOT NULL,
      embedding BLOB,
      last_indexed INTEGER,
      parent_uuid TEXT,
      is_sidechain BOOLEAN DEFAULT 0,
      session_id TEXT,
      cwd TEXT,
      git_branch TEXT,
      claude_version TEXT,
      thinking_level TEXT,
      thinking_disabled BOOLEAN,
      thinking_triggers TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result TEXT,
      is_error BOOLEAN DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${EMBEDDING_DIM}]
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_exchanges USING fts5(
      content_id UNINDEXED,
      user_message,
      assistant_message,
      tokenize='porter unicode61'
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

function makeExchange(overrides: Partial<ConversationExchange> & { id: string }): ConversationExchange {
  return {
    project: 'test-project',
    timestamp: '2024-01-01T00:00:00Z',
    userMessage: 'default user message',
    assistantMessage: 'default assistant message',
    archivePath: '/tmp/test.jsonl',
    lineStart: 1,
    lineEnd: 2,
    ...overrides
  };
}

function makeDummyEmbedding(): number[] {
  return Array.from({ length: EMBEDDING_DIM }, () => Math.random());
}

describe('FTS5 text search', () => {
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

  describe('FTS5 table creation', () => {
    it('should create FTS5 table idempotently', () => {
      // Table already created in setup, running again should not throw
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_exchanges USING fts5(
          content_id UNINDEXED,
          user_message,
          assistant_message,
          tokenize='porter unicode61'
        )
      `);
      const count = (db.prepare('SELECT COUNT(*) as count FROM fts_exchanges').get() as { count: number }).count;
      expect(count).toBe(0);
    });
  });

  describe('insert and search', () => {
    it('should find inserted exchanges via FTS5', () => {
      const exchange = makeExchange({
        id: 'ex1',
        userMessage: 'How do I configure authentication?',
        assistantMessage: 'You can set up OAuth2 with these steps...'
      });
      insertExchange(db, exchange, makeDummyEmbedding());

      const results = db.prepare(`
        SELECT content_id FROM fts_exchanges WHERE fts_exchanges MATCH '"authentication"'
      `).all();
      expect(results.length).toBe(1);
      expect((results[0] as any).content_id).toBe('ex1');
    });

    it('should support stemming (porter)', () => {
      const exchange = makeExchange({
        id: 'ex1',
        userMessage: 'The tests are running slowly',
        assistantMessage: 'Try optimizing the test runner'
      });
      insertExchange(db, exchange, makeDummyEmbedding());

      // Search for "run" should match "running" and "runner" via porter stemming
      const results = db.prepare(`
        SELECT content_id FROM fts_exchanges WHERE fts_exchanges MATCH '"run"'
      `).all();
      expect(results.length).toBe(1);
    });

    it('should be case-insensitive', () => {
      const exchange = makeExchange({
        id: 'ex1',
        userMessage: 'Configure the DATABASE connection',
        assistantMessage: 'Here is how to set up PostgreSQL'
      });
      insertExchange(db, exchange, makeDummyEmbedding());

      const results = db.prepare(`
        SELECT content_id FROM fts_exchanges WHERE fts_exchanges MATCH '"database"'
      `).all();
      expect(results.length).toBe(1);
    });
  });

  describe('delete', () => {
    it('should remove FTS entry when exchange is deleted', () => {
      const exchange = makeExchange({
        id: 'ex1',
        userMessage: 'unique search term xyzzy'
      });
      insertExchange(db, exchange, makeDummyEmbedding());

      // Verify it's indexed
      let results = db.prepare(`SELECT content_id FROM fts_exchanges WHERE fts_exchanges MATCH '"xyzzy"'`).all();
      expect(results.length).toBe(1);

      // Delete
      deleteExchange(db, 'ex1');

      // Verify it's removed from FTS
      results = db.prepare(`SELECT content_id FROM fts_exchanges WHERE fts_exchanges MATCH '"xyzzy"'`).all();
      expect(results.length).toBe(0);
    });
  });

  describe('migration', () => {
    it('should populate FTS index from existing exchanges', () => {
      // Insert directly into exchanges table (bypassing FTS)
      db.prepare(`
        INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ex1', 'proj', '2024-01-01', 'migration test query', 'response', '/tmp/t.jsonl', 1, 2);

      db.prepare(`
        INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ex2', 'proj', '2024-01-01', 'another query', 'another response', '/tmp/t.jsonl', 3, 4);

      // FTS should be empty
      let ftsCount = (db.prepare('SELECT COUNT(*) as count FROM fts_exchanges').get() as { count: number }).count;
      expect(ftsCount).toBe(0);

      // Run migration
      migrateFtsIndex(db);

      // FTS should now have 2 entries
      ftsCount = (db.prepare('SELECT COUNT(*) as count FROM fts_exchanges').get() as { count: number }).count;
      expect(ftsCount).toBe(2);

      // Should be searchable
      const results = db.prepare(`SELECT content_id FROM fts_exchanges WHERE fts_exchanges MATCH '"migration"'`).all();
      expect(results.length).toBe(1);
      expect((results[0] as any).content_id).toBe('ex1');
    });

    it('should skip migration if FTS already populated', () => {
      // Insert an exchange normally (populates FTS)
      const exchange = makeExchange({ id: 'ex1', userMessage: 'existing' });
      insertExchange(db, exchange, makeDummyEmbedding());

      const beforeCount = (db.prepare('SELECT COUNT(*) as count FROM fts_exchanges').get() as { count: number }).count;
      expect(beforeCount).toBe(1);

      // Run migration — should not duplicate
      migrateFtsIndex(db);

      const afterCount = (db.prepare('SELECT COUNT(*) as count FROM fts_exchanges').get() as { count: number }).count;
      expect(afterCount).toBe(1);
    });
  });

  describe('sanitizeFtsQuery', () => {
    it('should wrap words in quotes', () => {
      expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"');
    });

    it('should strip FTS5 special characters', () => {
      expect(sanitizeFtsQuery('foo:bar* "quoted" (grouped)')).toBe('"foo" "bar" "quoted" "grouped"');
    });

    it('should strip boost and required operators', () => {
      expect(sanitizeFtsQuery('test^2 +required')).toBe('"test2" "required"');
    });

    it('should return empty match for operator-only input', () => {
      expect(sanitizeFtsQuery('AND OR NOT')).toBe('""');
    });

    it('should return empty match for empty string', () => {
      expect(sanitizeFtsQuery('')).toBe('""');
    });

    it('should handle input with only special characters', () => {
      expect(sanitizeFtsQuery('"*():')).toBe('""');
    });
  });
});
