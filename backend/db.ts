import postgres from "postgres";

const sql = postgres({ onnotice: () => { } });

export async function setupDatabase() {
  await sql`
    CREATE TABLE IF NOT EXISTS devs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
  );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS bots (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      uploaded TIMESTAMPTZ NOT NULL,
      hash TEXT,
      dev_id INTEGER NOT NULL,
      FOREIGN KEY(dev_id) REFERENCES devs(id) ON DELETE CASCADE
    );
  `;

  await sql`
      ALTER TABLE bots ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT FALSE;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      bid INTEGER NOT NULL,
      wid INTEGER NOT NULL,
      started TIMESTAMPTZ,
      ended TIMESTAMPTZ,
      winner VARCHAR(1),
      initial_time_ms INTEGER NOT NULL,
      initial_position TEXT,
      current_position TEXT, -- used for quickly showing live games
      reason TEXT,
      FOREIGN KEY(wid) REFERENCES bots(id) ON DELETE CASCADE,
      FOREIGN KEY(bid) REFERENCES bots(id) ON DELETE CASCADE
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS moves (
      id SERIAL PRIMARY KEY,
      game_id INTEGER NOT NULL,
      move TEXT NOT NULL,
      color TEXT NOT NULL,
      time_ms INTEGER NOT NULL,
      FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS elo_updates (
      id SERIAL PRIMARY KEY,
      game_id INTEGER,
      bot_id INTEGER NOT NULL,
      change FLOAT NOT NULL,
      FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY(bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS dev_tokens (
      id SERIAL PRIMARY KEY,
      dev_id INTEGER,
      token TEXT NOT NULL,
      FOREIGN KEY(dev_id) REFERENCES devs(id) ON DELETE CASCADE
    );
  `;


  // This is a materialized view that is used to quickly get the elo of each bot.
  // Since this query is executed often I cache the result.
  await sql`
    CREATE MATERIALIZED VIEW IF NOT EXISTS bot_elos AS
      SELECT bots.id as bot_id, SUM(change)::float AS elo FROM bots
      LEFT JOIN elo_updates ON elo_updates.bot_id = bots.id
      GROUP BY bots.id;
  `;

  // I want to refresh the view whenever a new elo update is added. Sadly triggers
  // cannot call refresh directly, so I make this function that the trigger can call.
  await sql`
    CREATE OR REPLACE FUNCTION refresh_bot_elos()
    RETURNS TRIGGER LANGUAGE PLPGSQL
    AS
    $$
    BEGIN
      REFRESH MATERIALIZED VIEW bot_elos;
      RETURN NULL;
    END
    $$;
  `;

  await sql`
    CREATE OR REPLACE TRIGGER refresh_bot_elos_on_elo_updates_change
    AFTER INSERT OR UPDATE OR DELETE
    ON elo_updates
    FOR EACH STATEMENT
    EXECUTE PROCEDURE refresh_bot_elos();
  `;

  // This speeds up finding live and old games.
  await sql`CREATE INDEX IF NOT EXISTS games_ended ON games (ended);`;
  await sql`CREATE INDEX IF NOT EXISTS moves_game_id ON moves (game_id);`;
  await sql`CREATE INDEX IF NOT EXISTS elo_game_id ON elo_updates (game_id);`;
  await sql`CREATE INDEX IF NOT EXISTS elo_bot_id ON elo_updates (bot_id);`;

}

export { sql };
