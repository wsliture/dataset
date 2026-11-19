
export const categories = ['功能', '性能', '接口', '可靠性／安全性', '余量', '边界', '数据处理', '恢复', '强度', '其他']
export type Side = 'source' | 'test_requirement'
export type Status = 'draft' | 'published' | 'withdrawn'
export const sideNames = { source: '源需求／设计资料', test_requirement: '人工测试需求' }
export const statusNames = { draft: '草稿', published: '已确认', withdrawn: '已停用' }

export interface DatasetInput { name: string; note: string }
export interface Dataset extends DatasetInput { id: string; status: 'active' | 'archived'; updatedAt: string }
export interface DatasetSummary extends Dataset {
  documents: Record<Side, number>
  cases: Record<Status, number>
  searchable: number
}
export interface Excerpt {
  sliceId: string; text: string; documentId: string; documentName: string; sectionPath: string[]; sourceRef: string
}
export interface Slice extends Excerpt {
  kind: 'paragraph' | 'clause' | 'table' | 'table_row'
  parentSliceId?: string
  version: number
}
export interface Doc {
  id: string; name: string; datasetId: string; type: Side; slices: Slice[]; warnings: string[]; importedAt: string
}
export interface CaseInput {
  title: string; testObject: string; categories: string[]; interfaceType: string; scenario: string
  keywords: string; conditions: string; note: string; sourceSliceIds: string[]; testRequirementSliceIds: string[]
}
export interface CaseRecord extends CaseInput {
  id: string; datasetId: string; version: number; status: Status; updatedAt: string
}
export interface CaseDetail extends CaseRecord {
  sourceSlices: Excerpt[]; testRequirementSlices: Excerpt[]; valid: boolean
}
export interface Filters {
  q?: string; status?: Status; category?: string; testObject?: string; interfaceType?: string; scenario?: string
  updatedSince?: string; page?: number; pageSize?: number
}
export interface SearchResult {
  datasetId: string; datasetName: string; caseId: string; caseTitle: string
  matchedSourceSlices: Excerpt[]; testRequirementSlices: Excerpt[]
}
export interface DatasetClient {
  listDatasets(): Promise<DatasetSummary[]>
  getDataset(id: string): Promise<Dataset>
  saveDataset(input: DatasetInput, id?: string): Promise<Dataset>
  deleteDataset(id: string): Promise<void>
  listDocuments(id: string): Promise<Doc[]>
  importDocument(id: string, type: Side, file: Pick<File, 'name' | 'size'>, onParsing?: () => void): Promise<Doc>
  deleteDocument(id: string, documentId: string): Promise<void>
  updateSlice(id: string, documentId: string, sliceId: string, text: string, version: number): Promise<Doc>
  listCases(id: string, filters: Filters): Promise<{ items: CaseDetail[]; total: number }>
  getCase(id: string, caseId: string): Promise<CaseDetail>
  saveCase(id: string, input: CaseInput, existing?: { id: string; version: number }): Promise<CaseDetail>
  publishCase(id: string, caseId: string, version: number): Promise<CaseDetail>
  withdrawCase(id: string, caseId: string, version: number): Promise<CaseDetail>
  exportCases(id: string, filters: Filters): Promise<string>
  search(input: { query: string; limit?: number }): Promise<{ results: SearchResult[] }>
}
export const emptyCase = (): CaseInput => ({
  title: '', testObject: '', categories: [], interfaceType: '', scenario: '', keywords: '', conditions: '',
  note: '', sourceSliceIds: [], testRequirementSliceIds: [],
})
export function caseInput(record: CaseInput): CaseInput {
  const { title, testObject, categories, interfaceType, scenario, keywords, conditions, note,
    sourceSliceIds, testRequirementSliceIds } = record
  return { title, testObject, categories, interfaceType, scenario, keywords, conditions, note,
    sourceSliceIds, testRequirementSliceIds }
}
export function publicationError(input: CaseInput) {
  if (!input.title.trim()) return '请输入案例标题。'
  if (!input.testObject.trim()) return '请输入测试对象。'
  if (!input.categories.length) return '请至少选择一个测试类别。'
  if (!input.sourceSliceIds.length || !input.testRequirementSliceIds.length) return '两侧各需选择至少一个有效切片。'
}
export function toggleSlice(ids: string[], slice: Slice, slices: Slice[]) {
  if (ids.includes(slice.sliceId)) return ids.filter(id => id !== slice.sliceId)
  const excluded = new Set(slices.filter(item => item.parentSliceId === slice.sliceId).map(item => item.sliceId))
  if (slice.parentSliceId) excluded.add(slice.parentSliceId)
  return [...ids.filter(id => !excluded.has(id)), slice.sliceId]
}
export class ClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
export const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'


export function stripResults(results: SearchResult[], deleted: ReadonlySet<string>) {
  return results.filter(result => !deleted.has(result.datasetId))
}
