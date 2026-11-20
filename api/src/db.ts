import type { Pool, PoolClient } from 'pg'
import { readdir, readFile } from 'node:fs/promises'

export async function transaction<T>(
  pool: Pool, run: (client: PoolClient) => Promise<T>, readOnly = false,
): Promise<T> {
  const client = await pool.connect()
  let discard = false
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { discard = true }
    throw error
  } finally { client.release(discard) }
}

export async function migrate(pool: Pool) {
  const migrationDirectory = new URL('../migrations/', import.meta.url)
  const files = (await readdir(migrationDirectory)).filter(file => /^\d+_.*\.sql$/.test(file)).sort()
  await transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('matrix-dataset-migrations'))")
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)')
    for (const file of files) {
      const version = Number(file.split('_')[0])
      const { rowCount } = await db.query('SELECT FROM schema_migrations WHERE version=$1', [version])
      if (rowCount) continue
      await db.query(await readFile(new URL(file, migrationDirectory), 'utf8'))
      await db.query('INSERT INTO schema_migrations VALUES ($1)', [version])
    }
  })
}
