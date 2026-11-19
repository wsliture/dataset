
import { ClientError, caseInput, categories, emptyCase, publicationError, sideNames } from './client.ts'
import type { CaseDetail, CaseInput, CaseRecord, Dataset, DatasetClient, Doc, Filters, Side, Slice } from './client.ts'

type History = Record<string, string[]>
interface Database { datasets: Dataset[]; documents: Doc[]; cases: CaseRecord[]; history: History }
const stamp = '2026-11-12T08:30:00.000Z'
const now = () => new Date().toISOString()
export const storageKey = 'matrix.dataset.web.v1'

function sampleDocument(datasetId: string, id: string, type: Side, name: string, importedAt: string): Doc {
  const source = type === 'source'
  const section = source ? '3.2 CAN 控制器初始化' : '4.1 CAN 接口确认测试'
  const records: [Slice['kind'], string, string, number?][] = source ? [
    ['paragraph', 'CAN 控制器采用 SJA1000。上电后，软件应在复位模式下完成控制寄存器初始化。', '§ 3.2 / 段落 1'],
    ['clause', '初始化完成后，退出复位模式并读取状态寄存器，确认控制器进入正常工作模式。', '§ 3.2.1 / 条款 1'],
    ['table', '', '§ 3.2 / 表 1'],
    ['table_row', '寄存器：BTR0 ｜ 约束：按 500 kbps 配置位时序。', '§ 3.2 / 表 1 / 行 1', 2],
    ['table_row', '寄存器：MOD ｜ 约束：复位模式退出后，RM 位应为 0。', '§ 3.2 / 表 1 / 行 2', 2],
    ['paragraph', '当 CAN 接口检测到总线关闭时，应记录故障并按规定流程恢复通信。', '§ 3.3 / 段落 1'],
  ] : [
    ['paragraph', '上电启动被测软件，检查 SJA1000 初始化阶段控制器处于复位模式。', '§ 4.1 / 步骤 1'],
    ['clause', '读取模式和状态寄存器，确认 RM 位为 0 且控制器进入正常工作模式。', '§ 4.1 / 步骤 2'],
    ['paragraph', '连接总线分析仪，以 500 kbps 收发 CAN 帧，核对标识符及有效载荷。', '§ 4.1 / 步骤 3'],
    ['paragraph', '注入总线关闭状态并检查故障记录，恢复总线后验证通信恢复。', '§ 4.2 / 步骤 1'],
  ]
  const slices = records.map(([kind, text, sourceRef, parent], index): Slice => ({
    sliceId: id + '-' + index, documentId: id, documentName: name,
    sectionPath: [source ? '3 接口设计' : '4 接口测试', index === records.length - 1 ?
      (source ? '3.3 总线故障处理' : '4.2 故障恢复验证') : section],
    sourceRef, text, kind, version: 1, parentSliceId: parent == null ? undefined : id + '-' + parent,
  }))
  if (source) slices[2].text = slices.slice(3, 5).map(row => row.text).join('\n')
  return { id, name, datasetId, type, importedAt, slices, warnings: [] }
}

function seed(): Database {
  const datasets: Dataset[] = [
    { id: 'cnas', name: 'CNAS 嵌入式软件测试样例', note: '用于标注与检索演示。', status: 'active', updatedAt: stamp },
    { id: 'interface', name: '通信接口验证历史集', note: '', status: 'active', updatedAt: stamp },
    { id: 'archive', name: '设备控制软件归档集', note: '', status: 'archived', updatedAt: stamp },
  ]
  const documents = datasets.flatMap(dataset => [
    sampleDocument(dataset.id, dataset.id + '-source', 'source', 'CAN 接口设计说明.docx', stamp),
    sampleDocument(dataset.id, dataset.id + '-test', 'test_requirement', '人工确认测试需求.docx', stamp),
  ])
  const cases: CaseRecord[] = datasets.flatMap(dataset => {
    const source = dataset.id + '-source-'
    const test = dataset.id + '-test-'
    const sample: CaseRecord = {
      ...emptyCase(), id: dataset.id + '-can', datasetId: dataset.id, version: 1, status: 'published',
      updatedAt: stamp, title: 'CAN 控制器初始化与寄存器配置', testObject: 'SJA1000 控制器',
      categories: ['接口', '功能'], interfaceType: 'CAN', scenario: '上电初始化', keywords: 'SJA1000, CAN',
      conditions: '连接 CAN 分析仪，位速率 500 kbps', sourceSliceIds: [source + '0', source + '1'],
      testRequirementSliceIds: [test + '0', test + '1', test + '2'],
    }
    return dataset.id === 'cnas' ? [sample,
      { ...sample, id: 'can-recovery', title: 'CAN 总线关闭与通信恢复', status: 'draft', categories: ['恢复'],
        scenario: '总线关闭', sourceSliceIds: [source + '5'], testRequirementSliceIds: [test + '3'] },
      { ...sample, id: 'can-timing', title: 'CAN 位时序配置核对', status: 'withdrawn', categories: ['性能'],
        sourceSliceIds: [source + '3'], testRequirementSliceIds: [test + '2'] },
    ] : []
  })
  return { datasets, documents, cases, history: {} }
}

function missing(): never { throw new ClientError(404, 'not_found', '资源不存在或已删除。') }
function invalid(message: string): never { throw new ClientError(400, 'invalid', message) }
function conflict(message: string): never { throw new ClientError(409, 'conflict', message) }
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase()

export function createMockClient(options: {
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  delay?: number
  before?: (operation: keyof DatasetClient) => void | Promise<void>
} = {}): DatasetClient {
  let db = seed()
  function read() {
    const stored = options.storage?.getItem(storageKey)
    return stored ? JSON.parse(stored) as Database : structuredClone(db)
  }
  function write(next: Database) {
    options.storage?.setItem(storageKey, JSON.stringify(next))
    db = next
  }
  async function run<T>(operation: keyof DatasetClient, action: (data: Database) => T, mutates = false): Promise<T> {
    if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay))
    await options.before?.(operation)
    const data = read()
    const result = action(data)
    if (mutates) write(data)
    return structuredClone(result)
  }
  function dataset(data: Database, id: string, writable = false) {
    const value = data.datasets.find(item => item.id === id) ?? missing()
    if (writable && value.status === 'archived') conflict('归档数据集只允许查看。')
    return value
  }
  const docs = (data: Database, id: string) => data.documents.filter(doc => doc.datasetId === id)
  const docById = (data: Database, id: string, docId: string) => docs(data, id).find(doc => doc.id === docId) ?? missing()
  const record = (data: Database, id: string, caseId: string) =>
    data.cases.find(item => item.datasetId === id && item.id === caseId) ?? missing()
  function detail(data: Database, item: CaseRecord): CaseDetail {
    const scoped = docs(data, item.datasetId)
    function resolve(ids: string[], type: Side) {
      const slices = new Map(scoped.filter(doc => doc.type === type).flatMap(doc => doc.slices).map(slice => [slice.sliceId, slice]))
      return ids.flatMap(id => {
        const slice = slices.get(id)
        return slice ? [slice] : []
      })
    }
    const sourceSlices = resolve(item.sourceSliceIds, 'source')
    const testRequirementSlices = resolve(item.testRequirementSliceIds, 'test_requirement')
    const valid = Boolean(sourceSlices.length && testRequirementSlices.length &&
      sourceSlices.length === item.sourceSliceIds.length && testRequirementSlices.length === item.testRequirementSliceIds.length)
    return { ...item, sourceSlices, testRequirementSlices, valid }
  }
  function validateReferences(data: Database, item: CaseRecord) {
    const resolved = detail(data, item)
    for (const [ids, excerpts] of [[item.sourceSliceIds, resolved.sourceSlices], [item.testRequirementSliceIds, resolved.testRequirementSlices]] as const) {
      const selected = new Set(ids)
      if (selected.size !== ids.length || ids.length !== excerpts.length) invalid('切片已失效、重复或不属于当前数据集及对应分栏。')
      if ((excerpts as Slice[]).some(slice => slice.parentSliceId && selected.has(slice.parentSliceId))) invalid('整表与其所属行不可同时选择。')
    }
  }
  function checkVersion(actual: number, expected: number) {
    if (actual !== expected) conflict('记录已更新，请重新加载并核对本地改动。')
  }
  function remember(data: Database, item: CaseRecord) {
    data.history[item.id] = [...new Set([...(data.history[item.id] ?? []), ...item.sourceSliceIds, ...item.testRequirementSliceIds])]
  }
  function filtered(data: Database, id: string, filters: Filters) {
    dataset(data, id)
    const matches = (value: string, term?: string) => !term || normalize(value).includes(normalize(term))
    return data.cases.filter(item => item.datasetId === id).map(item => detail(data, item)).filter(item =>
      (!filters.status || item.status === filters.status) &&
      (!filters.category || item.categories.includes(filters.category)) &&
      matches(item.testObject, filters.testObject) && matches(item.interfaceType, filters.interfaceType) &&
      matches(item.scenario, filters.scenario) && (!filters.updatedSince || item.updatedAt >= filters.updatedSince) &&
      [item.title, ...item.sourceSlices.map(slice => slice.text), ...item.testRequirementSlices.map(slice => slice.text)]
        .some(value => matches(value, filters.q)),
    ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  }
  function changeStatus(data: Database, id: string, caseId: string, version: number, publish: boolean) {
    const owner = dataset(data, id, true)
    const item = record(data, id, caseId)
    checkVersion(item.version, version)
    if (publish) {
      const error = publicationError(item)
      if (error) invalid(error)
      validateReferences(data, item)
    } else if (item.status !== 'published') {
      conflict('当前案例无法停用。')
    }
    remember(data, item)
    item.status = publish ? 'published' : 'withdrawn'
    item.updatedAt = owner.updatedAt = now()
    item.version++
    return detail(data, item)
  }
  return {
    listDatasets: () => run('listDatasets', data => data.datasets.map(item => {
      const cases = data.cases.filter(entry => entry.datasetId === item.id)
      const documents = docs(data, item.id)
      return {
        ...item,
        documents: { source: documents.filter(doc => doc.type === 'source').length,
          test_requirement: documents.filter(doc => doc.type === 'test_requirement').length },
        cases: { draft: cases.filter(entry => entry.status === 'draft').length,
          published: cases.filter(entry => entry.status === 'published').length,
          withdrawn: cases.filter(entry => entry.status === 'withdrawn').length },
        searchable: item.status === 'active' ? cases.filter(entry => entry.status === 'published' && detail(data, entry).valid).length : 0,
      }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
    getDataset: id => run('getDataset', data => dataset(data, id)),
    saveDataset: (input, id) => run('saveDataset', data => {
      const name = input.name.trim()
      if (!name) invalid('请输入数据集名称。')
      const value = id ? dataset(data, id, true) : { id: crypto.randomUUID(), status: 'active' as const }
      const next = { ...value, ...input, name, updatedAt: now() }
      data.datasets = [...data.datasets.filter(item => item.id !== next.id), next]
      return next
    }, true),
    deleteDataset: id => run('deleteDataset', data => {
      dataset(data, id)
      for (const item of data.cases.filter(item => item.datasetId === id)) delete data.history[item.id]
      data.datasets = data.datasets.filter(item => item.id !== id)
      data.documents = data.documents.filter(item => item.datasetId !== id)
      data.cases = data.cases.filter(item => item.datasetId !== id)
    }, true),
    listDocuments: id => run('listDocuments', data => { dataset(data, id); return docs(data, id) }),
    async importDocument(id, type, file, onParsing) {
      if (!/\.docx$/i.test(file.name)) invalid('请选择 DOCX 文件。')
      if (!file.size) invalid('文件为空，请重新选择。')
      if (file.size > 25 * 1024 * 1024) invalid('模拟导入支持最大 25 MB 的文件。')
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay))
      onParsing?.()
      return run('importDocument', data => {
        const owner = dataset(data, id, true)
        if (docs(data, id).some(doc => doc.type === type && normalize(doc.name) === normalize(file.name)))
          conflict(sideNames[type] + '中已存在同名文档。')
        const doc = sampleDocument(id, crypto.randomUUID(), type, file.name, now())
        doc.warnings.push('模拟导入使用预置切片，文件内容未解析。')
        data.documents.push(doc)
        owner.updatedAt = now()
        return doc
      }, true)
    },
    deleteDocument: (id, documentId) => run('deleteDocument', data => {
      const owner = dataset(data, id, true)
      const doc = docById(data, id, documentId)
      const ids = new Set(doc.slices.map(slice => slice.sliceId))
      const blocking = data.cases.filter(item => item.datasetId === id &&
        [...item.sourceSliceIds, ...item.testRequirementSliceIds, ...(data.history[item.id] ?? [])].some(sliceId => ids.has(sliceId)))
      if (blocking.length) conflict('文档被案例当前或历史版本引用：' + blocking.map(item => item.title || '未命名案例').join('、'))
      data.documents = data.documents.filter(item => item.id !== documentId)
      owner.updatedAt = now()
    }, true),
    updateSlice: (id, documentId, sliceId, text, version) => run('updateSlice', data => {
      const owner = dataset(data, id, true)
      const doc = docById(data, id, documentId)
      const slice = doc.slices.find(item => item.sliceId === sliceId) ?? missing()
      checkVersion(slice.version, version)
      if (!text.trim()) invalid('切片文本不能为空。')
      if (slice.kind === 'table' && doc.slices.some(item => item.parentSliceId === sliceId)) invalid('请编辑表格行以更新整表文本。')
      slice.text = text.trim()
      slice.version++
      if (slice.parentSliceId) {
        const parent = doc.slices.find(item => item.sliceId === slice.parentSliceId) ?? missing()
        parent.text = doc.slices.filter(item => item.parentSliceId === parent.sliceId).map(item => item.text).join('\n')
        parent.version++
      }
      owner.updatedAt = now()
      return doc
    }, true),
    listCases: (id, filters) => run('listCases', data => {
      const all = filtered(data, id, filters)
      const size = filters.pageSize ?? 20
      const start = ((filters.page ?? 1) - 1) * size
      return { items: all.slice(start, start + size), total: all.length }
    }),
    getCase: (id, caseId) => run('getCase', data => detail(data, record(data, id, caseId))),
    saveCase: (id, input: CaseInput, existing) => run('saveCase', data => {
      const owner = dataset(data, id, true)
      const old = existing ? record(data, id, existing.id) : undefined
      if (old && existing) checkVersion(old.version, existing.version)
      if (input.categories.some(value => !categories.includes(value))) invalid('测试类别无效。')
      const item: CaseRecord = {
        ...caseInput(input), title: input.title.trim(), testObject: input.testObject.trim(), id: old?.id ?? crypto.randomUUID(),
        datasetId: id, status: 'draft', version: (old?.version ?? 0) + 1, updatedAt: now(),
      }
      validateReferences(data, item)
      if (old) remember(data, old)
      data.cases = [...data.cases.filter(entry => entry.id !== item.id), item]
      owner.updatedAt = item.updatedAt
      return detail(data, item)
    }, true),
    publishCase: (id, caseId, version) => run('publishCase', data => changeStatus(data, id, caseId, version, true), true),
    withdrawCase: (id, caseId, version) => run('withdrawCase', data => changeStatus(data, id, caseId, version, false), true),
    exportCases: (id, filters) => run('exportCases', data => {
      if (dataset(data, id).status !== 'active') return ''
      return filtered(data, id, filters).filter(item => item.status === 'published' && item.valid)
        .map(({ id: caseId, ...item }) => JSON.stringify({ schemaVersion: 1, caseId, ...item }) + '\n').join('')
    }),
    search: ({ query, limit = 5 }) => run('search', data => {
      const term = normalize(query)
      if (!term || !Number.isInteger(limit) || limit < 1) invalid('请输入查询文本和有效的返回条数。')
      const active = new Map(data.datasets.filter(item => item.status === 'active').map(item => [item.id, item.name]))
      return { results: data.cases.filter(item => active.has(item.datasetId) && item.status === 'published')
        .map(item => detail(data, item)).filter(item => item.valid).flatMap(item => {
          const ranked = item.sourceSlices.map(slice => ({ slice, score: rank(term, normalize(slice.text)) }))
            .filter(hit => hit.score > 0).sort((a, b) => b.score - a.score)
          if (!ranked.length) return []
          return [{ score: ranked[0].score, result: {
            datasetId: item.datasetId, datasetName: active.get(item.datasetId)!, caseId: item.id, caseTitle: item.title,
            matchedSourceSlices: ranked.map(hit => hit.slice), testRequirementSlices: item.testRequirementSlices,
          } }]
        }).sort((a, b) => b.score - a.score || a.result.caseId.localeCompare(b.result.caseId))
        .slice(0, limit).map(hit => hit.result) }
    }),
  }
}

function rank(query: string, text: string) {
  const identifiers = /[a-z][a-z0-9_-]*/g
  const words = new Set(text.match(identifiers) ?? [])
  const technical = [...new Set(query.match(identifiers) ?? [])]
  const phrase = /^[a-z][a-z0-9_-]*$/.test(query) ? words.has(query) : text.includes(query)
  if (phrase) return 1000
  let score = technical.filter(word => words.has(word)).length * 12
  const pairs = new Set<string>()
  for (const word of query.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let index = 1; index < word.length; index++) pairs.add(word.slice(index - 1, index + 1))
  }
  score += [...pairs].filter(pair => text.includes(pair)).length
  return score
}
