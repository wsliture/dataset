import { Pool } from 'pg'
import { configFrom } from './config.js'
import { migrate } from './db.js'

const pool = new Pool({ connectionString: configFrom().DATABASE_URL })
try { await migrate(pool) } finally { await pool.end() }
