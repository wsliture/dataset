
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Download, Plus, Search } from 'lucide-react'
import { categories, messageOf, sideNames, statusNames } from './client'
import type { CaseDetail, Filters, Status } from './client'
import { useDataset } from './datasets'
import { Badge, Confirm, dateText, Empty, ErrorText, Excerpts, Modal, ResourceState, useClient, useResource } from './ui'

const fields = [['testObject', '测试对象'], ['interfaceType', '接口类型'], ['scenario', '场景']] as const
const pageSize = 20

function Detail({ id, caseId, close }: { id: string; caseId: string; close: () => void }) {
  const client = useClient()
  const state = useResource(() => client.getCase(id, caseId), id + ':' + caseId)
  const item = state.data
  return <Modal wide title={item?.title || '案例详情'} close={close}>
    {item ? <>
      <Badge status={item.status} />
      {item.status === 'published' && !item.valid && <p className="notice">引用已失效，当前案例无法检索。</p>}
      <dl className="case-meta">
        {[[item.testObject, '测试对象'], [item.categories.join('、'), '测试类别'], [item.interfaceType, '接口类型'],
          [item.scenario, '场景'], [item.keywords, '关键词'], [item.conditions, '适用条件'],
          [item.note, '标注说明'], [dateText(item.updatedAt), '更新时间']].map(([value, label]) =>
          <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}
      </dl>
      <div className="split"><section><h3>{sideNames.source} · {item.sourceSlices.length}</h3><Excerpts slices={item.sourceSlices} /></section>
        <section><h3>{sideNames.test_requirement} · {item.testRequirementSlices.length}</h3><Excerpts slices={item.testRequirementSlices} /></section></div>
    </> : <ResourceState state={state} />}
  </Modal>
}

export function CasesPage() {
  const client = useClient()
  const dataset = useDataset()
  const readOnly = dataset.status === 'archived'
  const [params, setParams] = useSearchParams()
  const caseId = params.get('caseId')
  const [filter, setFilter] = useState<Filters>({ page: 1 })
  const [since, setSince] = useState('')
  const [withdraw, setWithdraw] = useState<CaseDetail>()
  const [exporting, setExporting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const state = useResource(() => client.listCases(dataset.id, filter), dataset.id + JSON.stringify(filter))
  const page = filter.page ?? 1
  const totalPages = Math.max(1, Math.ceil((state.data?.total ?? 0) / pageSize))
  function change(value: Filters) {
    setFeedback('')
    setError('')
    setFilter(previous => ({ ...previous, ...value, page: 1 }))
  }
  async function exportData() {
    setExporting(true)
    setFeedback('')
    setError('')
    try {
      const { page: _page, pageSize: _size, ...filters } = filter
      const content = await client.exportCases(dataset.id, filters)
      if (!content) { setFeedback('没有可导出的有效案例。'); return }
      const url = URL.createObjectURL(new Blob([content], { type: 'application/x-ndjson;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = '历史案例-' + dateText(new Date().toISOString()) + '.jsonl'
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setFeedback('已生成 JSONL 下载。')
    } catch (failure) { setError(messageOf(failure)) } finally { setExporting(false) }
  }

  return <>
    <div className="sub-head"><div><h2>案例列表</h2><p>查阅配对结果和确认状态。</p></div>
      {!readOnly && <Link className="button primary" to="../annotation"><Plus size={16} />新建案例</Link>}</div>
    <section className="panel">
      <div className="filters">
        <label className="search-field"><Search size={16} /><input type="search" aria-label="搜索案例标题或原文" placeholder="搜索案例标题或原文"
          value={filter.q ?? ''} onChange={event => change({ q: event.target.value })} /></label>
        <label>状态<select value={filter.status ?? ''} onChange={event => change({ status: event.target.value as Status || undefined })}>
          <option value="">全部状态</option>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>类别<select value={filter.category ?? ''} onChange={event => change({ category: event.target.value })}>
          <option value="">全部类别</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
        {fields.map(([field, label]) => <label key={field}>{label}
          <input value={filter[field] ?? ''} onChange={event => change({ [field]: event.target.value })} /></label>)}
        <label>更新自<input type="date" value={since} onChange={event => {
          const value = event.target.value
          setSince(value)
          change({ updatedSince: value ? new Date(value + 'T00:00:00').toISOString() : undefined })
        }} /></label>
        {!readOnly && <button disabled={exporting} onClick={exportData}><Download size={16} />{exporting ? '生成中…' : '导出筛选结果'}</button>}
      </div>
      <div className="list-feedback"><ErrorText error={error} />{feedback && <p role="status">{feedback}</p>}</div>
      {state.data ? <>
        {state.data.items.length ? <div className="table-wrap"><table><thead><tr><th>案例 / 测试对象</th><th>类别 / 场景</th><th>源侧 / 测试侧</th>
          <th>状态</th><th>更新日期</th><th>操作</th></tr></thead>
          <tbody>{state.data.items.map(item => <tr key={item.id}>
            <td><Link className="name" to={'?caseId=' + item.id}>{item.title || '未命名案例'}</Link><small>{item.testObject || '—'}</small></td>
            <td>{item.categories.join('、') || '—'}<small>{item.scenario || '—'}</small></td>
            <td>{item.sourceSlices.length} / {item.testRequirementSlices.length}</td><td><Badge status={item.status} /></td>
            <td>{dateText(item.updatedAt)}</td><td><div className="row nowrap">
              <Link className="text-button" to={'?caseId=' + item.id}>详情</Link>
              {!readOnly && <><Link className="text-button" to={'../annotation?caseId=' + item.id}>编辑</Link>
                {item.status === 'published' && <button className="text-button destructive" onClick={() => setWithdraw(item)}>停用</button>}</>}
            </div></td>
          </tr>)}</tbody></table></div> : <Empty title="没有符合条件的案例" />}
        <footer className="pagination"><span>共 {state.data.total} 条 · 第 {page} / {totalPages} 页</span>
          <div className="row"><button disabled={page <= 1} onClick={() => setFilter({ ...filter, page: page - 1 })}>上一页</button>
            <button disabled={page >= totalPages} onClick={() => setFilter({ ...filter, page: page + 1 })}>下一页</button></div></footer>
      </> : <ResourceState state={state} />}
    </section>
    {caseId && <Detail key={caseId} id={dataset.id} caseId={caseId} close={() => setParams({}, { replace: true })} />}
    {withdraw && <Confirm title="停用案例" label="确认停用" close={() => setWithdraw(undefined)} confirm={async () => {
      try { await client.withdrawCase(dataset.id, withdraw.id, withdraw.version) } finally { state.reload() }
    }}><p>停用「{withdraw.title}」后，该案例将退出新查询的结果。</p></Confirm>}
  </>
}
