import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { once } from 'node:events'
import { Pool } from 'pg'
import { createApp } from '../src/app.js'
import { searchCases } from '../src/cases.js'
import { configFrom } from '../src/config.js'
import { migrate } from '../src/db.js'
import { sweepFiles } from '../src/documents.js'
import { embeddingClient } from '../src/indexing.js'
import { writeZip } from '../src/parser/docx-zip.js'

import { docx, sourceTexts, testTexts } from './fixture.js'
const testDatabase = process.env.DATASET_TEST_DATABASE_URL

test('PostgreSQL API workflow, history, concurrency and model failures', { skip: !testDatabase }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dataset-integration-'))
  const pool = new Pool({ connectionString: testDatabase })
  await migrate(pool)
  let failure: 'dimension' | 'timeout' | undefined
  let paused: { release: Promise<void>; entered: () => void } | undefined
  let settingsFailure = false
  let settingsPause: typeof paused
  const modelCalls: { path: string | undefined; model: string; authorization: string | undefined }[] = []
  const stub = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const { input, model } = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[]; model: string }
    modelCalls.push({ path: request.url, model, authorization: request.headers.authorization })
    if (request.url === '/redirect') {
      response.writeHead(307, { Location: '/vectorize' }).end()
      return
    }
    if (request.url === '/vectorize') {
      const isProbe = input.length === 1 && input[0] === '嵌入式软件测试需求'
      if (settingsFailure && !isProbe) { response.writeHead(503).end(); return }
      if (settingsPause && !isProbe) {
        const pending = settingsPause
        settingsPause = undefined
        pending.entered()
        await pending.release
      }
    } else assert.equal(request.url, '/v1/embeddings')
    const current = paused
    paused = undefined
    if (current) { current.entered(); await current.release }
    if (failure === 'timeout') await new Promise(resolve => setTimeout(resolve, 1000))
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: input.map((text, index) => ({ index,
      embedding: failure === 'dimension' ? [1] : request.url === '/vectorize' ? [0, 0, 0, 1] :
        text.includes('TEMP') ? [0, 1, 0] : text.includes('CAN') ? [1, 0, 0] : [0, 0, 1],
    })).reverse() }))
  })
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  const address = stub.address()
  assert.ok(address && typeof address !== 'string')
  const realModel = process.env.DATASET_TEST_REAL_MODEL === '1'
  const stubBase = 'http://127.0.0.1:' + address.port
  const config = configFrom({
    ...process.env, DATABASE_URL: testDatabase, DOCUMENT_ROOT: directory, UPLOAD_LIMIT: '262144',
    ...(realModel ? {} : { EMBEDDING_BASE_URL: stubBase + '/v1',
      EMBEDDING_DIMENSION: '3', EMBEDDING_TIMEOUT_MS: '400', EMBEDDING_MODEL: 'test-bge' }),
  })
  const app = await createApp(config, { logger: process.env.DATASET_TEST_LOG === '1', cleanup: false })
  const url = await app.listen({ port: 0 })
  const prefix = url + '/api/v1'
  const created: string[] = []
  let savedEmbedding = false
  t.after(async () => {
    await app.close()
    stub.close()
    await once(stub, 'close')
    if (savedEmbedding) await pool.query('DELETE FROM embedding_settings')
    for (const id of created) {
      await pool.query('DELETE FROM cases WHERE dataset_id=$1', [id])
      await pool.query('DELETE FROM datasets WHERE id=$1', [id])
    }
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  })

  async function http(path: string, method = 'GET', body?: unknown) {
    const options = body instanceof FormData ? { body } : body === undefined ? {} :
      { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    return fetch(prefix + path, { method, ...options })
  }
  async function json(path: string, method: string, body: unknown, status = 200) {
    const response = await http(path, method, body)
    assert.equal(response.status, status, await response.clone().text())
    return response.json()
  }
  async function create(name: string) {
    const { id } = await json('/datasets', 'POST', { name }, 201)
    created.push(id)
    return '/datasets/' + id
  }
  function upload(type: string, filename: string, contents: Uint8Array) {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(contents)]), filename)
    form.append('type', type)
    return form
  }
  const d = await create('标注联调')
  const other = await create('隔离与归档')
  const source = await json(d + '/documents', 'POST', upload('source', '源文档.docx', docx(sourceTexts)), 201)
  const tests = await json(d + '/documents', 'POST', upload('test_requirement', '人工测试需求.docx', docx(testTexts)), 201)
  assert.deepEqual(source.slices.map((s: { kind: string }) => s.kind), ['paragraph', 'table', 'table_row', 'table_row', 'paragraph'])
  assert.match(source.slices[3].text, /接口：CAN-01/)
  const views = await json(d + '/documents/' + source.id + '/tables', 'GET', undefined)
  assert.equal(views[0].sliceId, source.slices[1].sliceId)
  assert.deepEqual(views[0].rows.map((row: { sliceId: string }) => row.sliceId),
    [source.slices[2].sliceId, source.slices[3].sliceId])
  await json(other + '/documents/' + source.id + '/tables', 'GET', undefined, 404)
  const artifactPath = join(directory, source.id, 'document-structure.json')
  await rename(artifactPath, artifactPath + '.backup')
  try {
    assert.deepEqual(await json(d + '/documents/' + source.id + '/tables', 'GET', undefined), [])
    assert.equal((await json(d + '/documents/' + source.id, 'GET', undefined)).slices.length, source.slices.length)
  } finally { await rename(artifactPath + '.backup', artifactPath) }
  assert.ok((await readFile(join(directory, source.id, 'original.docx'))).length)
  const structure = await readFile(join(directory, source.id, 'document-structure.json'), 'utf8')
  assert.equal(structure, JSON.stringify(JSON.parse(structure), null, 2) + '\n')
  await json(d + '/documents', 'POST', upload('source', '源文档.docx', docx(sourceTexts)), 409)
  await json(d + '/documents', 'POST', upload('source', '无法解析.docx', Buffer.from('not a zip')), 400)
  await json(d + '/documents', 'POST', upload('source', '超限.docx', Buffer.alloc(300000)), 413)
  await json(d + '/documents', 'POST', upload('source', '不可用.docx', writeZip([
    { path: 'word/document.xml', data: Buffer.from('<invalid>') },
  ])), 400)

  const input = {
    title: '控制器报警', testObject: '控制器', categories: ['功能'], interfaceType: 'CAN', scenario: '复位',
    keywords: '', conditions: '', note: '', sourceSliceIds: [source.slices[0].sliceId, source.slices[4].sliceId],
    testRequirementSliceIds: [tests.slices[0].sliceId, tests.slices[4].sliceId, tests.slices[5].sliceId],
  }
  await json(other + '/cases', 'POST', input, 400)
  await json(d + '/cases', 'POST', { ...input, sourceSliceIds: [source.slices[1].sliceId, source.slices[2].sliceId] }, 400)
  const draft = await json(d + '/cases', 'POST', input, 201)
  const item = d + '/cases/' + draft.id
  const search = (query: string) => json('/search', 'POST', { query })
  await json('/search', 'POST', { query: '   ' }, 400)
  await json('/search', 'POST', { query: 'CAN-01', limit: 0 }, 400)
  assert.deepEqual(await search(sourceTexts[0]), { results: [] })
  if (!realModel) {
    failure = 'dimension'
    await json(item + '/publish', 'POST', { version: 1 }, 503)
    failure = undefined
    let release!: () => void
    let entered!: () => void
    const accepted = new Promise<void>(resolve => { entered = resolve })
    paused = { entered, release: new Promise<void>(resolve => { release = resolve }) }
    const publishing = http(item + '/publish', 'POST', { version: 1 })
    await accepted
    try {
      await json(d + '/documents/' + source.id + '/slices/' + source.slices[0].sliceId, 'PATCH',
        { text: sourceTexts[0] + '保留原配置。', version: 1 })
    } finally { release() }
    assert.equal((await publishing).status, 409)
  }
  const published = await json(item + '/publish', 'POST', { version: 1 })
  assert.equal(published.status, 'published')
  for (const text of sourceTexts) {
    const { results } = await search(text)
    const match = results.find((result: { caseId: string }) => result.caseId === draft.id)
    assert.equal(match?.testRequirementSlices.length, 3)
    assert.ok(match.matchedSourceSlices.every((slice: { sourceRef: string }) => slice.sourceRef))
  }
  if (realModel) {
    const judgments = [
      { query: 'CAN-01', relevant: true, reason: '源描述包含同一完整接口标识' },
      { query: '控制器进入复位模式后如何初始化？', relevant: true, reason: '对应复位模式进入初始化状态的条款' },
      { query: '超过 80℃ 时控制器应触发超温告警', relevant: true, reason: '温度条件同义改写' },
      { query: 'TEMP-02 在八十摄氏度整时是否必须报警？', relevant: true, reason: '原文的严格大于边界可回答问题' },
      { query: '如何校准光学望远镜的主镜？', relevant: false, reason: '案例与光学校准无关' },
      { query: 'CAN-01 收发器的总线终端电阻值是多少？', relevant: false, reason: '接口相同但案例未涉及终端电阻' },
    ]
    const embed = embeddingClient(config)
    for (const mode of ['keyword', 'semantic', 'hybrid'] as const) {
      let hits = 0
      let falseReturns = 0
      const failures = []
      for (const { query, relevant, reason } of judgments) {
        const { results } = await searchCases(pool, config, embed, query, 5, mode)
        const found = results.some(result => result.caseId === draft.id)
        if (relevant && found) hits++
        if (!relevant && results.length) falseReturns++
        if ((relevant && !found) || (!relevant && results.length)) {
          failures.push({ query, expected: relevant ? input.title : null, actual: results.map(row => row.caseTitle), reason })
        }
      }
      t.diagnostic(JSON.stringify({ mode, hits, positive: 4, falseReturns, negative: 2, failures }))
    }
  }
  if (!realModel) {
    failure = 'timeout'
    await json('/search', 'POST', { query: 'CAN-01' }, 503)
    failure = 'dimension'
    await json(d + '/documents/' + source.id + '/slices/' + source.slices[0].sliceId, 'PATCH', { text: '失效写入', version: 2 }, 503)
    failure = undefined
    const detail = await json(item, 'GET', undefined)
    assert.match(detail.sourceSlices[0].text, /保留原配置/)
    assert.deepEqual(await search('不相关的飞行器舱门'), { results: [] })
  }

  const table = source.slices[1]
  const updateRow = (row: { sliceId: string; version: number }, text: string) =>
    http(d + '/documents/' + source.id + '/slices/' + row.sliceId, 'PATCH', { text, version: row.version })
  if (!realModel) {
    const tableCase = await json(d + '/cases', 'POST', { ...input, sourceSliceIds: [table.sliceId] }, 201)
    const tablePath = d + '/cases/' + tableCase.id
    await json(tablePath + '/publish', 'POST', { version: 1 })
    failure = 'dimension'
    assert.equal((await updateRow(source.slices[2], '提交失败的行')).status, 503)
    failure = undefined
    let entered!: () => void
    let release!: () => void
    const accepted = new Promise<void>(resolve => { entered = resolve })
    paused = { entered, release: new Promise<void>(resolve => { release = resolve }) }
    const editing = updateRow(source.slices[2], '较早启动的行修改')
    await accepted
    try { assert.equal((await updateRow(source.slices[3], '成功提交的行')).status, 200) }
    finally { release() }
    assert.equal((await editing).status, 409)
    await json(tablePath + '/withdraw', 'POST', { version: 2 })
  } else {
    const edits = await Promise.all([source.slices[2], source.slices[3]].map((row, i) => updateRow(row, '新表格行 ' + i)))
    assert.ok(edits.every(response => [200, 409].includes(response.status)))
  }
  const document = await json(d + '/documents/' + source.id, 'GET', undefined)
  const parent = document.slices.find((s: { sliceId: string }) => s.sliceId === table.sliceId)
  assert.equal(parent.text, document.slices.filter((s: { parentSliceId: string }) => s.parentSliceId === table.sliceId)
    .map((s: { text: string }) => s.text).join('\n'))

  const shared = await json(d + '/cases', 'POST', { ...input, title: '控制器共享案例' }, 201)
  await json(d + '/cases/' + shared.id + '/publish', 'POST', { version: 1 })
  const page = await json(d + '/cases?page=2&pageSize=1&q=控制器', 'GET', undefined)
  assert.equal(page.total, realModel ? 2 : 3)
  assert.equal(page.items.length, 1)
  const exported = await (await http(d + '/cases/export?page=2&pageSize=1&q=控制器')).text()
  assert.equal(exported.trim().split('\n').length, 2)
  assert.equal(JSON.parse(exported.split('\n')[0]).schemaVersion, 1)
  await json(item + '/withdraw', 'POST', { version: 1 }, 409)
  await json(item + '/withdraw', 'POST', { version: published.version })
  assert.ok((await search(sourceTexts[0])).results.some((r: { caseId: string }) => r.caseId === shared.id))

  if (!realModel) {
    const settingsPath = '/settings/embedding'
    const baseline = await json(settingsPath, 'GET', undefined)
    assert.equal(baseline.api_base, stubBase + '/v1/embeddings')
    const next = { api_base: stubBase + '/vectorize', model_name: 'new-bge', api_key: 'mock-key', revision: baseline.revision }
    const beforeInvalid = modelCalls.length
    for (const api_base of ['/vectorize', 'http:/vectorize', 'ftp://localhost/vectorize',
      'http://user:pass@localhost/vectorize', stubBase + '/vectorize?', stubBase + '/vectorize#']) {
      await json(settingsPath + '/test', 'POST', { ...next, api_base }, 400)
    }
    assert.equal(modelCalls.length, beforeInvalid)
    const beforeRedirect = modelCalls.length
    await json(settingsPath + '/test', 'POST', { ...next, api_base: stubBase + '/redirect' }, 503)
    assert.equal(modelCalls.length - beforeRedirect, 1)
    assert.deepEqual(await json(settingsPath + '/test', 'POST', next), { dimension: 4 })
    assert.deepEqual(modelCalls.at(-1), { path: '/vectorize', model: 'new-bge', authorization: 'Bearer mock-key' })

    settingsFailure = true
    await json(settingsPath, 'PUT', next, 503)
    settingsFailure = false
    assert.deepEqual(await json(settingsPath, 'GET', undefined), baseline)
    assert.ok((await search(sourceTexts[0])).results.some((r: { caseId: string }) => r.caseId === shared.id))

    let entered!: () => void
    let release!: () => void
    const accepted = new Promise<void>(resolve => { entered = resolve })
    settingsPause = { entered, release: new Promise<void>(resolve => { release = resolve }) }
    const switching = json(settingsPath, 'PUT', next, 409)
    await accepted
    try {
      const row = (await json(d + '/documents/' + source.id, 'GET', undefined)).slices[0]
      assert.equal((await updateRow(row, row.text + ' 保留 CAN-01')).status, 200)
    } finally { release() }
    assert.equal((await switching).code, 'EMBEDDING_INDEX_CHANGED')
    assert.deepEqual(await json(settingsPath, 'GET', undefined), baseline)

    const saved = await json(settingsPath, 'PUT', next)
    savedEmbedding = true
    assert.equal(saved.has_api_key, true)
    assert.ok(!JSON.stringify(saved).includes('mock-key'))
    await json(settingsPath + '/test', 'POST', { api_base: baseline.api_base, model_name: baseline.model_name,
      revision: saved.revision })
    assert.equal(modelCalls.at(-1)?.authorization, undefined)
    assert.ok((await search('语义测试 无共同词')).results.some((r: { caseId: string }) => r.caseId === shared.id))
    await json(settingsPath, 'PUT', next, 409)
    const restarted = await createApp(config, { logger: false, cleanup: false })
    try {
      assert.deepEqual((await restarted.inject('/api/v1' + settingsPath)).json(), saved)
    } finally { await restarted.close() }
    const cleared = await json(settingsPath, 'PUT', { ...next, api_key: null, revision: saved.revision })
    assert.equal(cleared.has_api_key, false)
    assert.equal(modelCalls.at(-1)?.authorization, undefined)
  }

  const historical = await json(d + '/documents', 'POST', upload('source', '历史.docx', docx(sourceTexts)), 201)
  const temp = await json(d + '/cases', 'POST', { ...input, sourceSliceIds: [historical.slices[0].sliceId] }, 201)
  await json(d + '/cases/' + temp.id, 'PATCH', { ...input, sourceSliceIds: [], version: temp.version })
  const blocked = await json(d + '/documents/' + historical.id, 'DELETE', undefined, 409)
  assert.equal(blocked.code, 'DOCUMENT_REFERENCED')
  assert.equal(blocked.blockingCases[0].id, temp.id)
  const free = await json(d + '/documents', 'POST', upload('source', '可删除.docx', docx(sourceTexts)), 201)
  assert.equal((await http(d + '/documents/' + free.id, 'DELETE')).status, 204)
  await sweepFiles(pool, directory, false)
  await assert.rejects(readFile(join(directory, free.id, 'original.docx')), { code: 'ENOENT' })

  await pool.query("UPDATE datasets SET status='archived' WHERE id=$1", [other.split('/').at(-1)])
  await json(other + '/cases', 'POST', input, 409)
  assert.equal((await http(other, 'DELETE')).status, 204)
  await pool.query("UPDATE datasets SET status='archived' WHERE id=$1", [d.split('/').at(-1)])
  assert.ok(!(await search(sourceTexts[0])).results.some((r: { caseId: string }) => r.caseId === shared.id))
  assert.equal(await (await http(d + '/cases/export')).text(), '')
  assert.equal((await http(d, 'DELETE')).status, 204)
  await sweepFiles(pool, directory, false)
  await assert.rejects(readFile(join(directory, source.id, 'original.docx')), { code: 'ENOENT' })
  assert.ok(!(await search(sourceTexts[0])).results.some((r: { caseId: string }) => r.caseId === shared.id))
  await json(d, 'GET', undefined, 404)
})
