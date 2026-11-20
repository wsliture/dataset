import { ClientError } from './client.ts'
import type { CaseDetail, Dataset, DatasetClient, DatasetSummary, Doc, Filters, SearchResult } from './client.ts'

function clientError(status: number, payload: unknown) {
  const { code, message } = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  return new ClientError(status, typeof code === 'string' ? code : 'HTTP_ERROR',
    typeof message === 'string' ? message : '请求失败，请重试。')
}

function query(filters: Filters) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return params.size ? '?' + params : ''
}

export function createHttpClient(base = '/api/v1', transport = globalThis.fetch): DatasetClient {
  async function request<T>(path: string, method = 'GET', body?: unknown, text = false): Promise<T> {
    const response = await transport(base + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (!response.ok) throw clientError(response.status, await response.json().catch(() => undefined))
    if (response.status === 204) return undefined as T
    return text ? await response.text() as T : await response.json() as T
  }
  const dataset = (id: string) => '/datasets/' + encodeURIComponent(id)
  const documents = (id: string) => dataset(id) + '/documents'
  const document = (id: string, doc: string) => documents(id) + '/' + encodeURIComponent(doc)
  const cases = (id: string) => dataset(id) + '/cases'
  const record = (id: string, item: string) => cases(id) + '/' + encodeURIComponent(item)
  return {
    listTables: (id, doc) => request<Awaited<ReturnType<DatasetClient['listTables']>>>(document(id, doc) + '/tables'),
    listDatasets: () => request<DatasetSummary[]>('/datasets'),
    getDataset: id => request<Dataset>(dataset(id)),
    saveDataset: (input, id) => request<Dataset>(id ? dataset(id) : '/datasets', id ? 'PATCH' : 'POST', input),
    deleteDataset: id => request<void>(dataset(id), 'DELETE'),
    listDocuments: id => request<Doc[]>(documents(id)),
    importDocument: (id, type, file, onParsing) => new Promise<Doc>((resolve, reject) => {
      const form = new FormData()
      form.append('type', type)
      form.append('file', file)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', base + documents(id))
      xhr.responseType = 'json'
      xhr.upload.addEventListener('load', () => onParsing?.())
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error('上传失败，请重试。'))
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response) resolve(xhr.response as Doc)
        else reject(clientError(xhr.status, xhr.response))
      }
      xhr.send(form)
    }),
    deleteDocument: (id, doc) => request<void>(document(id, doc), 'DELETE'),
    updateSlice: (id, doc, slice, text, version) =>
      request<Doc>(document(id, doc) + '/slices/' + encodeURIComponent(slice), 'PATCH', { text, version }),
    listCases: (id, filters) => request<{ items: CaseDetail[]; total: number }>(cases(id) + query(filters)),
    getCase: (id, item) => request<CaseDetail>(record(id, item)),
    saveCase: (id, input, existing) => existing
      ? request<CaseDetail>(record(id, existing.id), 'PATCH', { ...input, version: existing.version })
      : request<CaseDetail>(cases(id), 'POST', input),
    publishCase: (id, item, version) => request<CaseDetail>(record(id, item) + '/publish', 'POST', { version }),
    withdrawCase: (id, item, version) => request<CaseDetail>(record(id, item) + '/withdraw', 'POST', { version }),
    exportCases: (id, filters) => request<string>(cases(id) + '/export' + query(filters), 'GET', undefined, true),
    search: input => request<{ results: SearchResult[] }>('/search', 'POST', input),
  }
}
