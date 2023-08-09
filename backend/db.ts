import { Database } from "bun:sqlite";
const db = new Database("db.sqlite");

db.query('PRAGMA foreign_keys = ON;').run();

db.query(`
  CREATE TABLE IF NOT EXISTS humans (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE
  );
`).run();

db.query(`
  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    uploaded TEXT NOT NULL,
    hash TEXT,
    human_id INTEGER NOT NULL,
    FOREIGN KEY(human_id) REFERENCES humans(id) ON DELETE CASCADE
  );
`).run();

db.query(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    bid INTEGER NOT NULL,
    wid INTEGER NOT NULL,
    started TEXT,
    ended TEXT,
    winner VARCHAR(1),
    initial_time_ms NUMBER NOT NULL,
    initial_position TEXT,
    reason TEXT,
    FOREIGN KEY(wid) REFERENCES bots(id) ON DELETE CASCADE,
    FOREIGN KEY(bid) REFERENCES bots(id) ON DELETE CASCADE
  );
`).run();

db.query(`
  CREATE TABLE IF NOT EXISTS moves (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL,
    move TEXT NOT NULL,
    color TEXT NOT NULL,
    time NUMBER NOT NULL,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
  );
`).run();

db.query(`
  CREATE INDEX IF NOT EXISTS moves_game_id ON moves (game_id);
`).run();

db.query(`
  CREATE TABLE IF NOT EXISTS elo_updates (
    id INTEGER PRIMARY KEY,
    game_id INTEGER,
    bot_id INTEGER NOT NULL,
    change INTEGER NOT NULL,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(bot_id) REFERENCES bots(id) ON DELETE CASCADE
  );
`).run();

// Clean old games.
db.query('DELETE FROM games WHERE ended IS NULL;').run();

export { db };
