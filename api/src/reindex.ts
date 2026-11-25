import { Pool } from 'pg'
import { configFrom } from './config.js'
import { activeEmbeddingConfig, rebuildEmbeddingIndex } from './embedding-settings.js'

const config = configFrom()
const pool = new Pool({ connectionString: config.DATABASE_URL })
try {
  const active = await activeEmbeddingConfig(pool, config)
  const count = await rebuildEmbeddingIndex(pool, active)
  console.log('Reindexed ' + count + ' source slices for ' + active.EMBEDDING_MODEL)
} finally { await pool.end() }
