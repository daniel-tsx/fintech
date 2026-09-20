import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main(): Promise<void> {
  const client = postgres(process.env.DATABASE_URL ?? 'postgres://fintech:fintech@localhost:5432/fintech_lab', { max: 1 });
  try { await migrate(drizzle(client), { migrationsFolder: './drizzle' }); }
  finally { await client.end(); }
}

void main();
