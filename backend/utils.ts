import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import sql from "./db";

export function makeTmpDir() {
  const rnd = randomBytes(16).toString('base64url');
  return `${tmpdir()}/chess-${rnd}`;
}

export async function getElo(botId: number): Promise<number> {
  const res = await sql`SELECT SUM(change)::float FROM elo_updates WHERE bot_id = ${botId}`;
  return res[0].sum;
}
