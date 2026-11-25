import OpenAI from 'openai'
import { legacyEmbeddingEndpoint, type Config } from './config.js'
import { ApiError, normalize } from './contract.js'

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
export function tokens(text: string) {
  const normalized = normalize(text)
  const words = [...segmenter.segment(normalized)].filter(word => word.isWordLike).map(word => word.segment)
  const identifiers = normalized.match(/[a-z0-9_][a-z0-9_.:/-]*/g)?.map(word => word.replace(/[.:/\-]+$/, ''))
    .filter(word => /[a-z_]/.test(word)) ?? []
  return { words, identifiers: [...new Set(identifiers)] }
}
export const vectorLiteral = (vector: number[]) => '[' + vector.join(',') + ']'

export function embeddingClient(config: Config, dimension: number | null = config.EMBEDDING_DIMENSION) {
  const endpoint = config.embeddingEndpoint ?? legacyEmbeddingEndpoint(config)
  const client = new OpenAI({
    baseURL: new URL(endpoint).origin,
    apiKey: config.EMBEDDING_API_KEY || 'unused',
    adminAPIKey: null,
    organization: null,
    project: null,
    timeout: config.EMBEDDING_TIMEOUT_MS,
    maxRetries: 0,
    logLevel: 'off',
    fetchOptions: { redirect: 'error' },
  })
  return async (texts: string[]): Promise<number[][]> => {
    const result: number[][] = []
    try {
      for (let i = 0; i < texts.length; i += config.EMBEDDING_BATCH_SIZE) {
        const input = texts.slice(i, i + config.EMBEDDING_BATCH_SIZE)
        const { data } = await client.post<{ data: { index: number; embedding: number[] }[] }>(endpoint, {
          headers: config.EMBEDDING_API_KEY ? undefined : { Authorization: null },
          body: { input, model: config.EMBEDDING_MODEL },
        })
        if (!Array.isArray(data) || data.length !== input.length) throw new Error('Embedding count mismatch')
        const ordered = Array<number[]>(input.length)
        for (const { index, embedding } of data) {
          if (!Number.isInteger(index) || index < 0 || index >= input.length || ordered[index] ||
              !Array.isArray(embedding) || embedding.length > 16000 || (dimension !== null && embedding.length !== dimension) ||
              embedding.some(value => typeof value !== 'number' || !Number.isFinite(Math.fround(value))) ||
              !embedding.some(value => Math.fround(value) !== 0)) throw new Error('Invalid vector')
          ordered[index] = embedding
        }
        result.push(...ordered)
      }
      return result
    } catch {
      throw new ApiError(503, 'EMBEDDING_UNAVAILABLE', '向量模型请求失败或返回了无效向量，请检查连接配置。')
    }
  }
}
