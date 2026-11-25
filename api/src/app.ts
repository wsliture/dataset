import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import multipart from '@fastify/multipart'
import staticFiles from '@fastify/static'
import Fastify from 'fastify'
import { Pool } from 'pg'
import { z } from 'zod'
import { changeCaseStatus, getCase, listCases, saveCase, searchCases } from './cases.js'
import type { Config } from './config.js'
import { ApiError, caseInput, datasetInput, filters, missing, pagination, read, searchInput, uuid, version } from './contract.js'
import { deleteDocument, importDocument, listDocuments, sweepFiles, updateSlice } from './documents.js'
import { embeddingClient } from './indexing.js'
import { activeEmbeddingConfig, embeddingSettingsInput, probeEmbedding,
  publicEmbeddingSettings, saveEmbeddingSettings } from './embedding-settings.js'
import { dataset, deleteDataset, listDatasets, saveDataset } from './repository.js'
import { documentTableViews } from './tables.js'

export async function createApp(config: Config, options: { logger?: boolean; cleanup?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true })
  const pool = new Pool({ connectionString: config.DATABASE_URL })
  try {
    await pool.query('SELECT 1 FROM datasets LIMIT 0')
    await activeEmbeddingConfig(pool, config)
  }
  catch (error) { await pool.end(); throw error }
  const activeEmbedding = () => activeEmbeddingConfig(pool, config)
  await mkdir(join(config.DOCUMENT_ROOT, '.staging'), { recursive: true })
  await app.register(multipart, { limits: { fileSize: config.UPLOAD_LIMIT, files: 1, fields: 1, parts: 3 } })

  let activeCleanup: Promise<void> | undefined
  let lastOrphanScan = 0
  const cleanup = () => {
    if (activeCleanup) return
    const sweepOrphans = Date.now() - lastOrphanScan > 5 * 60 * 1000
    activeCleanup = sweepFiles(pool, config.DOCUMENT_ROOT, sweepOrphans)
      .then(() => { if (sweepOrphans) lastOrphanScan = Date.now() })
      .catch(error => { app.log.error({ err: error }, 'Document cleanup failed') })
      .finally(() => { activeCleanup = undefined })
  }
  const timer = options.cleanup === false ? undefined : setInterval(cleanup, 10000).unref()
  if (timer) cleanup()
  app.addHook('onClose', async () => { clearInterval(timer); await activeCleanup; await pool.end() })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.status >= 500 || error.cause) request.log.warn({ err: error }, 'API operation failed')
      return reply.code(error.status).send({ code: error.code, message: error.message, ...error.extra })
    }
    if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
      return reply.code(413).send({ code: 'DOCX_TOO_LARGE', message: 'DOCX 上传大小超限。' })
    }
    if (error instanceof Error && 'statusCode' in error &&
        typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ code: 'INVALID_REQUEST', message: '请求格式或大小无效。' })
    }
    request.log.error({ err: error }, 'Unhandled API error')
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务暂时不可用，请重试。' })
  })

  await app.register(async api => {
    const d = '/datasets/:datasetId'
    const datasetParams = z.object({ datasetId: uuid })
    const docParams = datasetParams.extend({ documentId: uuid })
    const caseParams = datasetParams.extend({ caseId: uuid })
    const sliceParams = z.object({ datasetId: uuid, documentId: uuid, sliceId: uuid })
    const versionInput = z.object({ version })

    api.get('/settings/embedding', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store')
      return publicEmbeddingSettings(await activeEmbedding())
    })
    api.post('/settings/embedding/test', async request => {
      const input = read(embeddingSettingsInput, request.body)
      const candidate = await probeEmbedding(await activeEmbedding(), input)
      return { dimension: candidate.EMBEDDING_DIMENSION }
    })
    api.put('/settings/embedding', async request => {
      const input = read(embeddingSettingsInput, request.body)
      const active = await activeEmbedding()
      const candidate = await probeEmbedding(active, input)
      return publicEmbeddingSettings(await saveEmbeddingSettings(pool, active, candidate))
    })

    api.get('/datasets', () => listDatasets(pool))
    api.post('/datasets', async (request, reply) => reply.code(201).send(await saveDataset(pool, read(datasetInput, request.body))))
    api.get(d, request => dataset(pool, read(datasetParams, request.params).datasetId))
    api.patch(d, request => saveDataset(pool, read(datasetInput, request.body), read(datasetParams, request.params).datasetId))
    api.delete(d, async (request, reply) => {
      await deleteDataset(pool, read(datasetParams, request.params).datasetId)
      if (timer) cleanup()
      return reply.code(204).send()
    })

    api.get(d + '/documents', request => listDocuments(pool, read(datasetParams, request.params).datasetId))
    api.post(d + '/documents', async (request, reply) =>
      reply.code(201).send(await importDocument(pool, config, read(datasetParams, request.params).datasetId, request)))
    api.get(d + '/documents/:documentId', async request => {
      const { datasetId, documentId } = read(docParams, request.params)
      return (await listDocuments(pool, datasetId, documentId))[0]
    })
    api.get(d + '/documents/:documentId/tables', async request => {
      const { datasetId, documentId } = read(docParams, request.params)
      const document = await pool.query('SELECT FROM documents WHERE dataset_id=$1 AND id=$2', [datasetId, documentId])
      if (!document.rowCount) missing()
      return (await documentTableViews(pool, config.DOCUMENT_ROOT, datasetId, [documentId])).get(documentId) ?? []
    })
    api.delete(d + '/documents/:documentId', async (request, reply) => {
      const { datasetId, documentId } = read(docParams, request.params)
      await deleteDocument(pool, datasetId, documentId)
      if (timer) cleanup()
      return reply.code(204).send()
    })
    api.patch(d + '/documents/:documentId/slices/:sliceId', async request => {
      const { datasetId, documentId, sliceId } = read(sliceParams, request.params)
      const input = read(z.object({ text: z.string().trim().min(1), version }), request.body)
      const active = await activeEmbedding()
      return updateSlice(pool, active, embeddingClient(active), datasetId, documentId, sliceId, input.text, input.version)
    })
    api.get(d + '/cases', request => listCases(pool, read(datasetParams, request.params).datasetId,
      read(filters, request.query), read(pagination, request.query)))
    api.get(d + '/cases/export', async (request, reply) => {
      const { datasetId } = read(datasetParams, request.params)
      const { items } = await listCases(pool, datasetId, read(filters, request.query), undefined, config.DOCUMENT_ROOT)
      const jsonl = items.map(({ id, ...item }) => JSON.stringify({ schemaVersion: 1, caseId: id, ...item }) + '\n').join('')
      return reply.type('application/x-ndjson; charset=utf-8').send(jsonl)
    })
    api.post(d + '/cases', async (request, reply) => reply.code(201).send(await saveCase(pool,
      read(datasetParams, request.params).datasetId, read(caseInput, request.body))))
    api.get(d + '/cases/:caseId', async request => {
      const { datasetId, caseId } = read(caseParams, request.params)
      return getCase(pool, datasetId, caseId, config.DOCUMENT_ROOT)
    })
    api.patch(d + '/cases/:caseId', request => {
      const { datasetId, caseId } = read(caseParams, request.params)
      const input = read(caseInput.extend({ version }), request.body)
      const { version: suppliedVersion, ...fields } = input
      return saveCase(pool, datasetId, fields, { id: caseId, version: suppliedVersion })
    })
    for (const action of ['publish', 'withdraw']) {
      api.post(d + '/cases/:caseId/' + action, async request => {
        const { datasetId, caseId } = read(caseParams, request.params)
        const active = await activeEmbedding()
        return changeCaseStatus(pool, active, embeddingClient(active), datasetId, caseId,
          read(versionInput, request.body).version, action === 'publish')
      })
    }
    api.post('/search', async request => {
      const { query, limit } = read(searchInput, request.body)
      const search = async () => {
        const active = await activeEmbedding()
        return searchCases(pool, active, embeddingClient(active), query, limit)
      }
      try { return await search() }
      catch (error) {
        if (error instanceof ApiError && error.code === 'EMBEDDING_SETTINGS_CHANGED') return search()
        throw error
      }
    })
  }, { prefix: '/api/v1' })

  const serveWeb = existsSync(join(config.WEB_ROOT, 'index.html'))
  if (serveWeb) await app.register(staticFiles, { root: config.WEB_ROOT, wildcard: false })
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]
    if (serveWeb && (request.method === 'GET' || request.method === 'HEAD') &&
        !/^\/api(?:\/|$)/.test(path) && !path.startsWith('/assets/')) return reply.sendFile('index.html')
    return missing()
  })
  return app
}
