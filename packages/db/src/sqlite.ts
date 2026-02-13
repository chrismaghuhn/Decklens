import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';

// Create SQLite database file
const sqlite = new Database('./mtg.db');
export const db = drizzle(sqlite, { schema });

export { schema };