import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { db } from "./db";

export function makeTmpDir() {
  const rnd = randomBytes(16).toString('base64url');
  return `${tmpdir()}/chess-${rnd}`;
}

export function getElo(botId: number): number {
  return db
    .query("SELECT coalesce(SUM(change), 0) AS elo FROM elo_updates WHERE bot_id = ?1")
    .get(botId).elo;
}
