import { Pool } from 'pg'
import { configFrom } from './config.js'
import { transaction } from './db.js'
import { embeddingClient, vectorLiteral } from './indexing.js'

const config = configFrom()
const pool = new Pool({ connectionString: config.DATABASE_URL })
const embed = embeddingClient(config)
try {
  const { rows } = await pool.query<{ id: string; text: string; version: number }>(`
    SELECT DISTINCT s.id,s.text,s.version FROM eligible_cases c
    JOIN case_slices r ON r.case_id=c.id AND r.side='source'
    JOIN slices s ON s.id=r.slice_id ORDER BY s.id`)
  const vectors = await embed(rows.map(row => row.text))
  await transaction(pool, async db => {
    await db.query('LOCK TABLE datasets IN EXCLUSIVE MODE')
    const { rows: current } = await db.query<{ id: string; version: number }>(`
      SELECT DISTINCT s.id,s.version FROM eligible_cases c
      JOIN case_slices r ON r.case_id=c.id AND r.side='source'
      JOIN slices s ON s.id=r.slice_id ORDER BY s.id`)
    if (rows.length !== current.length || rows.some((row, i) => row.id !== current[i].id || row.version !== current[i].version)) {
      throw new Error('Searchable slices changed during reindexing')
    }
    for (const [index, row] of rows.entries()) {
      await db.query('UPDATE slices SET embedding=$2::vector,embedding_model=$3,embedding_version=version WHERE id=$1',
        [row.id, vectorLiteral(vectors[index]), config.EMBEDDING_MODEL])
    }
  })
  console.log('Reindexed ' + rows.length + ' source slices for ' + config.EMBEDDING_MODEL)
} finally { await pool.end() }
