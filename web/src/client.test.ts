
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { caseInput, emptyCase, toggleSlice, stripResults } from './client.ts'
import { createMockClient, storageKey } from './mock.ts'

test('发布两对三案例，按源切片查询并合并多个命中', async () => {
  const client = createMockClient()
  const sample = await client.getCase('cnas', 'cnas-can')
  for (const slice of sample.sourceSlices) {
    const result = (await client.search({ query: slice.text })).results.find(item => item.caseId === sample.id)
    assert.equal(result?.testRequirementSlices.length, 3)
    assert.ok(result?.testRequirementSlices.every(item => item.documentName && item.sectionPath.length && item.sourceRef))
  }
  const { results } = await client.search({ query: '复位模式' })
  assert.equal(results.filter(item => item.caseId === sample.id).length, 1)
  assert.equal(results.find(item => item.caseId === sample.id)?.matchedSourceSlices.length, 2)
  const shared = await client.saveCase('cnas', { ...caseInput(sample), title: '复用切片' })
  await client.publishCase('cnas', shared.id, shared.version)
  assert.equal((await client.search({ query: 'SJA1000' })).results.length, 2)
})

test('归档只读，拒绝跨数据集和错侧引用，草稿和停用均不可检索', async () => {
  const client = createMockClient()
  const sample = await client.getCase('cnas', 'cnas-can')
  await assert.rejects(client.saveCase('interface', caseInput(sample)), { status: 400 })
  await assert.rejects(client.saveCase('archive', emptyCase()), { status: 409 })
  await assert.rejects(client.saveCase('cnas', { ...caseInput(sample), sourceSliceIds: ['cnas-test-0'] }), { status: 400 })
  const draft = await client.saveCase('cnas', emptyCase())
  await assert.rejects(client.publishCase('cnas', draft.id, draft.version), { status: 400 })
  const incomplete = await client.saveCase('cnas', { ...caseInput(sample), testRequirementSliceIds: [] })
  await assert.rejects(client.publishCase('cnas', incomplete.id, incomplete.version), { status: 400 })
  await client.withdrawCase('cnas', sample.id, sample.version)
  assert.deepEqual(await client.search({ query: 'SJA1000' }), { results: [] })
})

test('整表与行互斥，行更新同步整表，版本冲突保留当前文本', async () => {
  const client = createMockClient()
  const doc = (await client.listDocuments('cnas')).find(item => item.type === 'source')!
  const table = doc.slices.find(slice => slice.kind === 'table')!
  const row = doc.slices.find(slice => slice.kind === 'table_row')!
  assert.deepEqual(toggleSlice([table.sliceId], row, doc.slices), [row.sliceId])
  assert.deepEqual(toggleSlice([row.sliceId], table, doc.slices), [table.sliceId])
  await assert.rejects(client.saveCase('cnas', { ...emptyCase(), sourceSliceIds: [table.sliceId, row.sliceId] }), { status: 400 })
  const edited = await client.updateSlice('cnas', doc.id, row.sliceId, '修订行内容', row.version)
  assert.match(edited.slices.find(slice => slice.sliceId === table.sliceId)!.text, /修订行内容/)
  await assert.rejects(client.updateSlice('cnas', doc.id, row.sliceId, '冲突文本', row.version), { status: 409 })
})

test('文档删除保护当前与历史引用，过期案例版本无法写入', async () => {
  const client = createMockClient()
  const doc = await client.importDocument('cnas', 'source', { name: '临时.docx', size: 10 })
  const blocked = await client.saveCase('cnas', { ...emptyCase(), sourceSliceIds: [doc.slices[0].sliceId] })
  await assert.rejects(client.deleteDocument('cnas', doc.id), { status: 409 })
  await client.saveCase('cnas', emptyCase(), blocked)
  await assert.rejects(client.deleteDocument('cnas', doc.id), { status: 409 })
  await assert.rejects(client.saveCase('cnas', emptyCase(), blocked), { status: 409 })
  const free = await client.importDocument('cnas', 'source', { name: '可删除.docx', size: 10 })
  await client.deleteDocument('cnas', free.id)
  assert.ok(!(await client.listDocuments('cnas')).some(item => item.id === free.id))
})

test('导出跨页且仅含有效确认案例，筛选语义与列表相同', async () => {
  const client = createMockClient()
  const sample = await client.getCase('cnas', 'cnas-can')
  for (let index = 0; index < 21; index++) {
    const saved = await client.saveCase('cnas', { ...caseInput(sample), title: '跨页用例 ' + index })
    await client.publishCase('cnas', saved.id, saved.version)
  }
  const list = await client.listCases('cnas', { q: '跨页', page: 2 })
  assert.equal(list.total, 21)
  assert.equal(list.items.length, 1)
  const records = (await client.exportCases('cnas', { q: '跨页', page: 2 })).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.length, list.total)
  assert.ok(records.every(item => item.schemaVersion === 1 && item.status === 'published'))
})

test('模拟导入、保存、删除与查询故障可重试，持久化仅在成功后提交', async () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const failures = new Set(['importDocument', 'saveCase', 'deleteDataset', 'search'])
  const client = createMockClient({ storage, delay: 1, before(operation) {
    if (failures.delete(operation)) throw new Error('模拟服务故障')
  } })
  await assert.rejects(client.importDocument('cnas', 'source', { name: '非法.txt', size: 1 }), { status: 400 })
  await assert.rejects(client.importDocument('cnas', 'source', { name: '导入.docx', size: 0 }), { status: 400 })
  const file = { name: '导入.docx', size: 10 }
  await assert.rejects(client.importDocument('cnas', 'source', file), /模拟服务故障/)
  assert.equal(values.size, 0)
  await client.importDocument('cnas', 'source', file)
  await assert.rejects(client.importDocument('cnas', 'source', file), { status: 409 })
  const before = values.get(storageKey)
  await assert.rejects(client.saveCase('cnas', emptyCase()), /模拟服务故障/)
  await assert.rejects(client.deleteDataset('cnas'), /模拟服务故障/)
  assert.equal(values.get(storageKey), before)
  await client.saveCase('cnas', emptyCase())
  await assert.rejects(client.search({ query: 'SJA1000' }), /模拟服务故障/)
  assert.equal((await client.search({ query: 'SJA1000' })).results.length, 1)
  await client.deleteDataset('cnas')
  const reloaded = createMockClient({ storage })
  await assert.rejects(reloaded.getDataset('cnas'), { status: 404 })
  assert.equal((await reloaded.search({ query: 'SJA1000' })).results.length, 0)
})

test('删除清理旧轮次及迟到结果，其余数据集结果保留', async () => {
  const client = createMockClient()
  const response = await client.search({ query: 'SJA1000' })
  assert.equal(response.results.length, 1)
  await client.deleteDataset('cnas')
  const deleted = new Set(['cnas'])
  assert.deepEqual(stripResults(response.results, deleted), [])
  const another = { ...response.results[0], datasetId: 'another' }
  assert.deepEqual(stripResults([...response.results, another], deleted), [another])
  assert.deepEqual(await client.search({ query: 'SJA1000' }), { results: [] })
})
