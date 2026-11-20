import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyCase, stripResults, toggleSlice } from './client.ts'
import type { SearchResult, Slice } from './client.ts'
import { createHttpClient } from './http.ts'

test('HTTP paths, methods, version and filter encoding match the API contract', async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = []
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    if (String(url).includes('/export')) return new Response('{"schemaVersion":1}\n')
    return Response.json({})
  }
  const client = createHttpClient('/api/v1', transport)
  const filters = { q: '接口 A&B', updatedSince: '2026-11-20T00:00:00.000Z', page: 2 }
  await client.listCases('set', filters)
  assert.equal(await client.exportCases('set', filters), '{"schemaVersion":1}\n')
  await client.saveCase('set', emptyCase(), { id: 'case', version: 3 })
  await client.publishCase('set', 'case', 4)
  await client.withdrawCase('set', 'case', 5)
  await client.updateSlice('set', 'doc', 'slice', '修订', 7)
  assert.equal(await client.deleteDocument('set', 'doc'), undefined)
  await client.search({ query: 'CAN-01', limit: 2 })
  assert.equal(new URL(calls[0].url, 'http://localhost').searchParams.get('q'), filters.q)
  assert.equal(new URL(calls[0].url, 'http://localhost').searchParams.get('updatedSince'), filters.updatedSince)
  assert.equal(calls[1].url.replace('/export', ''), calls[0].url)
  assert.deepEqual(calls.slice(2), [
    { url: '/api/v1/datasets/set/cases/case', method: 'PATCH', body: { ...emptyCase(), version: 3 } },
    { url: '/api/v1/datasets/set/cases/case/publish', method: 'POST', body: { version: 4 } },
    { url: '/api/v1/datasets/set/cases/case/withdraw', method: 'POST', body: { version: 5 } },
    { url: '/api/v1/datasets/set/documents/doc/slices/slice', method: 'PATCH', body: { text: '修订', version: 7 } },
    { url: '/api/v1/datasets/set/documents/doc', method: 'DELETE', body: undefined },
    { url: '/api/v1/search', method: 'POST', body: { query: 'CAN-01', limit: 2 } },
  ])
})

test('HTTP errors retain status, code and display message', async () => {
  const client = createHttpClient('/api/v1', async () =>
    Response.json({ code: 'VERSION_CONFLICT', message: '请重新加载。' }, { status: 409 }))
  await assert.rejects(client.publishCase('set', 'case', 1), { status: 409, code: 'VERSION_CONFLICT', message: '请重新加载。' })
})

test('table selection replaces children or parent and deleted datasets are removed from results', () => {
  const table: Slice = { sliceId: 'table', kind: 'table', version: 1, documentId: 'doc', documentName: '说明',
    sectionId: 'SRS-001', sectionPath: ['接口'], sourceRef: '表1', text: '表' }
  const row: Slice = { ...table, sliceId: 'row', parentSliceId: 'table', kind: 'table_row' }
  assert.deepEqual(toggleSlice(['table'], row, [table, row]), ['row'])
  assert.deepEqual(toggleSlice(['row'], table, [table, row]), ['table'])
  const result: SearchResult = { datasetId: 'active', datasetName: '数据集', caseId: 'case', caseTitle: '案例',
    matchedSourceSlices: [], testRequirementSlices: [] }
  assert.deepEqual(stripResults([{ ...result, datasetId: 'deleted' }, result], new Set(['deleted'])), [result])
})
