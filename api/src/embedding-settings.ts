import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { legacyEmbeddingEndpoint, type Config } from './config.js'
import { ApiError, invalid } from './contract.js'
import { checkEmbeddingRevision, lockEmbeddingIndex, transaction } from './db.js'
import { embeddingClient, vectorLiteral } from './indexing.js'

export const embeddingSettingsInput = z.object({
  api_base: z.string().trim().min(1).max(2048),
  model_name: z.string().trim().min(1).max(256),
  api_key: z.string().trim().min(1).max(4096).nullable().optional(),
  revision: z.number().int().min(0).max(2147483647),
})
type SettingsInput = z.infer<typeof embeddingSettingsInput>
type RuntimeConfig = Config & { embeddingEndpoint: string; embeddingRevision: number }

function endpointUrl(value: string) {
  if (!/^https?:\/\/[^/\\?#]+/i.test(value) || /[?#]/.test(value)) {
    throw new Error('Expected a complete HTTP(S) endpoint without query or fragment')
  }
  const url = new URL(value)
  if (url.username || url.password) {
    throw new Error('Embedding endpoint must be an HTTP(S) URL without credentials, query or fragment')
  }
  return url.href
}

export async function activeEmbeddingConfig(pool: Pool, config: Config): Promise<RuntimeConfig> {
  const { rows: [row] } = await pool.query<{
    endpoint: string; model_name: string; api_key: string | null; dimension: number; revision: number
  }>('SELECT endpoint, model_name, api_key, dimension, revision FROM embedding_settings')
  return row ? {
    ...config, embeddingEndpoint: row.endpoint, embeddingRevision: row.revision, EMBEDDING_MODEL: row.model_name,
    EMBEDDING_API_KEY: row.api_key ?? undefined, EMBEDDING_DIMENSION: row.dimension,
  } : { ...config, embeddingEndpoint: endpointUrl(legacyEmbeddingEndpoint(config)), embeddingRevision: 0 }
}

export function publicEmbeddingSettings(config: RuntimeConfig) {
  return {
    api_base: config.embeddingEndpoint, model_name: config.EMBEDDING_MODEL,
    has_api_key: Boolean(config.EMBEDDING_API_KEY), revision: config.embeddingRevision,
  }
}

export async function probeEmbedding(active: RuntimeConfig, input: SettingsInput): Promise<RuntimeConfig> {
  if (input.revision !== active.embeddingRevision) {
    throw new ApiError(409, 'EMBEDDING_SETTINGS_CHANGED', '模型设置已变更，请刷新后重试。')
  }
  let endpoint: string
  try { endpoint = endpointUrl(input.api_base) }
  catch { return invalid('请输入完整的 HTTP(S) 模型接口地址，地址中不能包含凭据、查询参数或片段。') }
  const config = {
    ...active, embeddingEndpoint: endpoint, EMBEDDING_MODEL: input.model_name,
    EMBEDDING_API_KEY: input.api_key === undefined && endpoint === active.embeddingEndpoint
      ? active.EMBEDDING_API_KEY : input.api_key ?? undefined,
  }
  const [vector] = await embeddingClient(config, null)(['嵌入式软件测试需求'])
  return { ...config, EMBEDDING_DIMENSION: vector.length }
}

const sourceSlices = `
  FROM eligible_cases c
  JOIN case_slices r ON r.case_id=c.id AND r.side='source'
  JOIN slices s ON s.id=r.slice_id ORDER BY s.id`

async function writeIndex(db: PoolClient, rows: { id: string; version: number }[], vectors: number[][], model: string) {
  const { rows: current } = await db.query<{ id: string; version: number }>('SELECT DISTINCT s.id,s.version ' + sourceSlices)
  if (rows.length !== current.length || rows.some((row, i) => row.id !== current[i].id || row.version !== current[i].version)) {
    throw new ApiError(409, 'EMBEDDING_INDEX_CHANGED', '重建期间案例或切片已变更，请重试。')
  }
  await db.query(`UPDATE slices SET embedding=NULL, embedding_model=NULL, embedding_version=NULL
    WHERE embedding IS NOT NULL AND NOT (id = ANY($1::uuid[]))`, [rows.map(row => row.id)])
  for (const [index, row] of rows.entries()) {
    await db.query('UPDATE slices SET embedding=$2::vector, embedding_model=$3, embedding_version=version WHERE id=$1',
      [row.id, vectorLiteral(vectors[index]), model])
  }
}

export async function rebuildEmbeddingIndex(pool: Pool, config: RuntimeConfig, save?: (db: PoolClient) => Promise<void>) {
  const { rows } = await pool.query<{ id: string; text: string; version: number }>(
    'SELECT DISTINCT s.id,s.text,s.version ' + sourceSlices)
  const vectors = await embeddingClient(config)(rows.map(row => row.text))
  await transaction(pool, async db => {
    await lockEmbeddingIndex(db, true)
    await checkEmbeddingRevision(db, config.embeddingRevision)
    await writeIndex(db, rows, vectors, config.EMBEDDING_MODEL)
    await save?.(db)
  })
  return rows.length
}

export async function saveEmbeddingSettings(pool: Pool, active: RuntimeConfig, next: RuntimeConfig) {
  const revision = active.embeddingRevision + 1
  const save = async (db: PoolClient) => {
    await db.query(`INSERT INTO embedding_settings (revision, endpoint, model_name, api_key, dimension)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (singleton) DO UPDATE SET
      revision=excluded.revision, endpoint=excluded.endpoint, model_name=excluded.model_name,
      api_key=excluded.api_key, dimension=excluded.dimension`,
    [revision, next.embeddingEndpoint, next.EMBEDDING_MODEL, next.EMBEDDING_API_KEY ?? null, next.EMBEDDING_DIMENSION])
  }
  if (active.embeddingEndpoint !== next.embeddingEndpoint || active.EMBEDDING_MODEL !== next.EMBEDDING_MODEL ||
      active.EMBEDDING_DIMENSION !== next.EMBEDDING_DIMENSION) {
    await rebuildEmbeddingIndex(pool, next, save)
  } else {
    await transaction(pool, async db => {
      await lockEmbeddingIndex(db, true)
      await checkEmbeddingRevision(db, active.embeddingRevision)
      await save(db)
    })
  }
  return { ...next, embeddingRevision: revision }
}
