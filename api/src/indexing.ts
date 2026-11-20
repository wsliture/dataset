import type { Config } from './config.js'
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

export function embeddingClient(config: Config) {
  return async (texts: string[]): Promise<number[][]> => {
    const result: number[][] = []
    try {
      for (let i = 0; i < texts.length; i += config.EMBEDDING_BATCH_SIZE) {
        const input = texts.slice(i, i + config.EMBEDDING_BATCH_SIZE)
        const response = await fetch(config.EMBEDDING_BASE_URL.replace(/\/+$/, '') + '/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(config.EMBEDDING_API_KEY ? { Authorization: 'Bearer ' + config.EMBEDDING_API_KEY } : {}) },
          body: JSON.stringify({ input, model: config.EMBEDDING_MODEL }),
          signal: AbortSignal.timeout(config.EMBEDDING_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error('Embedding HTTP ' + response.status)
        const { data } = await response.json() as { data: { index: number; embedding: number[] }[] }
        if (!Array.isArray(data) || data.length !== input.length) throw new Error('Embedding count mismatch')
        const ordered = Array<number[]>(input.length)
        for (const { index, embedding } of data) {
          if (!Number.isInteger(index) || index < 0 || index >= input.length || ordered[index] ||
              !Array.isArray(embedding) || embedding.length !== config.EMBEDDING_DIMENSION ||
              embedding.some(value => typeof value !== 'number' || !Number.isFinite(Math.fround(value))) ||
              !embedding.some(value => Math.fround(value) !== 0)) throw new Error('Invalid vector')
          ordered[index] = embedding
        }
        result.push(...ordered)
      }
      return result
    } catch (cause) {
      const error = new ApiError(503, 'EMBEDDING_UNAVAILABLE', '向量模型暂不可用，请重试。')
      error.cause = cause
      throw error
    }
  }
}
