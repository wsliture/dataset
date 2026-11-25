import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DOCUMENT_ROOT: z.string().default(fileURLToPath(new URL('../storage', import.meta.url))),
  WEB_ROOT: z.string().default(fileURLToPath(new URL('../../web/dist', import.meta.url))),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4190),
  UPLOAD_LIMIT: z.coerce.number().int().positive().default(25 * 1024 ** 2),
  DOCX_EXPANDED_LIMIT: z.coerce.number().int().positive().default(250 * 1024 ** 2),
  EMBEDDING_BASE_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:57997/v1'),
  EMBEDDING_MODEL: z.string().min(1).default('BAAI/bge-m3'),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().max(16000).default(1024),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(8),
  SEARCH_MIN_COSINE: z.coerce.number().min(-1).max(1).default(0.55),
  SEARCH_CANDIDATES: z.coerce.number().int().positive().default(100),
})
export type Config = z.infer<typeof schema> & { embeddingEndpoint?: string; embeddingRevision?: number }
export const legacyEmbeddingEndpoint = (config: Config) => config.EMBEDDING_BASE_URL.replace(/\/+$/, '') + '/embeddings'
export function configFrom(env = process.env): Config {
  const config = schema.parse(env)
  return { ...config, DOCUMENT_ROOT: resolve(config.DOCUMENT_ROOT), WEB_ROOT: resolve(config.WEB_ROOT) }
}
