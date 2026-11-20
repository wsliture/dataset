
import { useEffect, useState } from 'react'
import { useBlocker, useSearchParams } from 'react-router-dom'
import { Check, Eye, FileText, Save } from 'lucide-react'
import { caseInput, categories, emptyCase, messageOf, publicationError, sideNames, toggleSlice } from './client'
import type { CaseDetail, CaseInput, Doc, Side, Slice, TableView } from './client'
import { useDataset } from './datasets'
import { groupSlices } from './documents'
import { OriginalTable, TableExcerpt, tableIndex, useTableViews } from './original-table'
import { Badge, Empty, ErrorText, Modal, Provenance, ResourceState, useClient, useResource } from './ui'

const sides = ['source', 'test_requirement'] as const
const fieldBySide = { source: 'sourceSliceIds', test_requirement: 'testRequirementSliceIds' } as const
const fields = [['title', '案例标题'], ['testObject', '测试对象'], ['interfaceType', '接口类型'], ['scenario', '场景'],
  ['keywords', '关键词'], ['conditions', '适用条件'], ['note', '标注说明']] as const

function PairPreview({ input, slices, views }: { input: CaseInput; slices: [Slice[], Slice[]]; views: Map<string, TableView> }) {
  return <>
    <dl className="case-meta">{fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{input[key] || '—'}</dd></div>)}
      <div><dt>测试类别</dt><dd>{input.categories.join('、') || '—'}</dd></div></dl>
    <div className="split">{sides.map((side, index) => <section key={side}><h3>{sideNames[side]} · {slices[index].length}</h3>
      <div className="excerpts">{slices[index].map(slice => <article key={slice.sliceId}>
        <TableExcerpt slice={slice} views={views} />
      </article>)}</div></section>)}</div>
  </>
}

function SlicePane({ side, docs, ids, update, readOnly, visible, reload }: {
  side: Side; docs: Doc[]; ids: string[]; update: (ids: string[]) => void; readOnly: boolean; visible: boolean; reload: () => void
}) {
  const [docId, setDocId] = useState('')
  const [section, setSection] = useState('')
  const [search, setSearch] = useState('')
  const doc = docs.find(item => item.id === docId) ?? docs[0]
  const client = useClient()
  const { id } = useDataset()
  const tables = useResource(() => doc ? client.listTables(id, doc.id) : Promise.resolve([]),
    id + ':' + (doc?.id ?? '') + ':' + (doc?.slices.map(slice => slice.version).join(',') ?? ''))
  const views = tableIndex(tables.data)
  const sections = groupSlices(doc?.slices ?? [])
  const active = sections.has(section) ? section : sections.keys().next().value
  const query = search.trim().toLowerCase()
  const slices = query ? doc?.slices.filter(slice => slice.text.toLowerCase().includes(query)) ?? [] : sections.get(active ?? '') ?? []
  const independent = slices.filter(slice => !slice.parentSliceId)
  const matches = new Set(query ? slices.map(slice => slice.sliceId) : [])
  const visibleSlices = (query ? doc?.slices ?? [] : slices).filter(slice => {
    if (slice.parentSliceId && views.has(slice.parentSliceId)) return false
    return !query || matches.has(slice.sliceId) || (views.get(slice.sliceId)?.rows.some(row => row.sliceId && matches.has(row.sliceId)) ?? false)
  })
  function selectSection() {
    const selected = independent.reduce((current, slice) => current.includes(slice.sliceId) ? current :
      toggleSlice(current, slice, doc?.slices ?? []), ids)
    update(selected)
  }
  return <section className={'panel slice-pane ' + (visible ? 'mobile-visible' : '')}>
    <header className="section-head"><div className="row"><span className="table-icon"><FileText size={17} /></span>
      <div><h3>{sideNames[side]}</h3><p>已选 {ids.length} 个切片</p></div></div></header>
    {doc ? <>
      <div className="pane-controls">
        <label>文档<select value={doc.id} onChange={event => { setDocId(event.target.value); setSection(''); setSearch(''); reload() }}>
          {docs.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>搜索正文<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索当前文档" /></label>
        <label>章节<select value={active} onChange={event => { setSection(event.target.value); setSearch('') }}>
          {[...sections].map(([id, items]) => <option key={id} value={id}>{items[0].sectionPath.join(' / ')} ({id})</option>)}</select></label>
      </div>
      <div className="pane-summary"><span>{query ? '搜索结果' : '当前章节'} · {slices.length} 个切片</span>
        {!query && <button disabled={readOnly || !independent.length} onClick={selectSection}>选择本节</button>}</div>
      <div className="slice-list">{visibleSlices.length ? visibleSlices.map(slice => {
        const table = views.get(slice.sliceId)
        return table ? <OriginalTable key={slice.sliceId} table={table} slices={doc.slices} selected={ids}
          matches={matches} readOnly={readOnly} onSelect={item => update(toggleSlice(ids, item, doc.slices))} /> : <label key={slice.sliceId}
        className={'slice-option ' + (ids.includes(slice.sliceId) ? 'selected ' : '') + (slice.parentSliceId ? 'nested' : '')}>
        <input type="checkbox" checked={ids.includes(slice.sliceId)} disabled={readOnly}
          onChange={() => update(toggleSlice(ids, slice, doc.slices))} />
        <div><span className="muted">{({ paragraph: '段落', clause: '条款', table: '整表', table_row: '表格行' })[slice.kind]}</span>
          <p>{slice.text}</p><Provenance slice={slice} /></div>
      </label>}) : <Empty title="没有匹配切片" />}</div>
    </> : <Empty title="暂无可选文档">请先在文档管理中导入。</Empty>}
  </section>
}

function Workspace({ initial, docs, reload, readOnly, datasetId }: {
  initial?: CaseDetail; docs: Doc[]; reload: () => void; readOnly: boolean; datasetId: string
}) {
  const client = useClient()
  const [, setParams] = useSearchParams()
  const [record, setRecord] = useState(initial)
  const [value, setValue] = useState(() => initial ? caseInput(initial) : emptyCase())
  const [lastSaved, setLastSaved] = useState(value)
  const [side, setSide] = useState<Side>('source')
  const [modal, setModal] = useState<'preview' | 'publish'>()
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [syncId, setSyncId] = useState<string>()
  const dirty = JSON.stringify(value) !== JSON.stringify(lastSaved)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty &&
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search))
  useEffect(() => {
    if (syncId && !dirty) {
      setParams({ caseId: syncId }, { replace: true })
      setSyncId(undefined)
    }
  }, [syncId, dirty, setParams])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const resolved = sides.map(sideName => {
    const all = docs.filter(doc => doc.type === sideName).flatMap(doc => doc.slices)
    return value[fieldBySide[sideName]].flatMap(id => all.filter(slice => slice.sliceId === id))
  }) as [Slice[], Slice[]]
  const stale = resolved.some((list, index) => list.length !== value[fieldBySide[sides[index]]].length)
  const selectedViews = useTableViews(datasetId, resolved.flat())
  function update<Key extends keyof CaseInput>(key: Key, input: CaseInput[Key]) {
    setValue(previous => ({ ...previous, [key]: input }))
    setFeedback('')
  }
  async function save(publish = false, leaving = false) {
    setWorking(true)
    setError('')
    setFeedback('')
    setConflict(false)
    try {
      let saved = record
      if (!saved || dirty) {
        saved = await client.saveCase(datasetId, value, record)
        setRecord(saved)
        setValue(caseInput(saved))
        setLastSaved(caseInput(saved))

      }
      if (publish) {
        saved = await client.publishCase(datasetId, saved.id, saved.version)
        setRecord(saved)
        setModal(undefined)
      }
      if (!initial && !leaving) setSyncId(saved.id)
      setFeedback(publish ? '案例已确认，可参与检索。' : '草稿已保存。')
      return true
    } catch (failure) {
      setError(messageOf(failure))
      setConflict(Boolean(failure && typeof failure === 'object' && 'status' in failure && failure.status === 409))
      return false
    } finally { setWorking(false) }
  }
  function startPublish() {
    const problem = publicationError(value) ?? (stale ? '请移除失效切片后再发布。' : '')
    setFeedback('')
    setError(problem)
    if (!problem) setModal('publish')
  }
  async function reconcile() {
    if (!record) return
    setWorking(true)
    try {
      const latest = await client.getCase(datasetId, record.id)
      setRecord(latest)
      setLastSaved(caseInput(latest))
      setConflict(false)
      setError('')
      setFeedback('已加载最新版本。请核对当前编辑内容后再保存。')
      reload()
    } catch (failure) { setError(messageOf(failure)) } finally { setWorking(false) }
  }

  return <>
    <div className="sub-head"><div><h2>标注工作台</h2><p>{record ? record.title || '未命名案例' : '新建配对案例'}</p></div><Badge status={record?.status ?? 'draft'} /></div>
    <div className="mobile-switch" aria-label="切换标注分栏">{sides.map(item => <button key={item} aria-pressed={side === item} onClick={() => setSide(item)}>
      {sideNames[item]} · {value[fieldBySide[item]].length}</button>)}</div>
    <div className="split">{sides.map(item => <SlicePane key={item} side={item} docs={docs.filter(doc => doc.type === item)}
      ids={value[fieldBySide[item]]} update={ids => update(fieldBySide[item], ids)} visible={side === item} readOnly={readOnly || working} reload={reload} />)}</div>
    <details className="panel selections"><summary>已选片段 <span>源侧 {value.sourceSliceIds.length} · 测试侧 {value.testRequirementSliceIds.length}</span></summary>
      <div className="split">{sides.map((item, index) => <section key={item}><h3>{sideNames[item]}</h3>
        {value[fieldBySide[item]].map(id => {
          const slice = resolved[index].find(candidate => candidate.sliceId === id)
          return <div className="selection-row" key={id}><div>{slice ? <TableExcerpt slice={slice} views={selectedViews} /> : <p className="error">切片已失效</p>}</div>
            {!readOnly && <button disabled={working} onClick={() => update(fieldBySide[item], value[fieldBySide[item]].filter(entry => entry !== id))}>移除</button>}</div>
        })}
        {!value[fieldBySide[item]].length && <p className="muted">尚未选择切片</p>}</section>)}</div>
    </details>
    <section className="panel case-form"><h3>案例信息</h3>
      <div className="form-grid">{fields.map(([key, label], index) => <label key={key}>{label}{index < 2 && <span className="required"> *</span>}
        {key === 'note' ? <textarea disabled={readOnly || working} value={value[key]} onChange={event => update(key, event.target.value)} rows={2} />
          : <input disabled={readOnly || working} value={value[key]} onChange={event => update(key, event.target.value)} />}
      </label>)}</div>
      <fieldset disabled={readOnly || working}><legend>测试类别 <span className="required">*</span></legend>
        <div className="chips">{categories.map(category => <button key={category} aria-pressed={value.categories.includes(category)} onClick={() =>
          update('categories', value.categories.includes(category) ? value.categories.filter(item => item !== category) : [...value.categories, category])}>{category}</button>)}</div>
      </fieldset>
      <div className="actions">
        <button onClick={() => setModal('preview')}><Eye size={16} />预览配对</button>
        {!readOnly && <><button disabled={working || Boolean(record && !dirty)} onClick={() => save()}><Save size={16} />保存草稿</button>
          <button disabled={working || (record?.status === 'published' && !dirty)} className="primary" onClick={startPublish}><Check size={17} />人工确认</button></>}
      </div>
      {!modal && !blocker.state.startsWith('block') && <ErrorText error={error} />}
      {conflict && !modal && <button disabled={working} onClick={reconcile}>加载最新版本</button>}
      {feedback && <p className="success" role="status">{feedback}</p>}
    </section>
    {modal && <Modal wide title={modal === 'publish' ? '确认案例配对' : '预览案例配对'} close={() => { if (!working) setModal(undefined) }}>
      <PairPreview input={value} slices={resolved} views={selectedViews} />
      {modal === 'publish' && <div className="confirmation">
        <ErrorText error={error} />
        {conflict && <button disabled={working} onClick={reconcile}>加载最新版本</button>}
        <div className="actions"><button disabled={working} onClick={() => setModal(undefined)}>返回编辑</button>
          <button className="primary" disabled={working} onClick={() => save(true)}>{working ? '确认中…' : '确认并发布'}</button></div>
      </div>}
    </Modal>}
    {blocker.state === 'blocked' && <Modal title="标注尚未保存" close={() => { if (!working) blocker.reset() }}>
      <p>离开前可以保存当前草稿，或放弃本次修改。</p><ErrorText error={error} />
      <div className="actions"><button disabled={working} onClick={() => blocker.reset()}>继续编辑</button>
        <button disabled={working} onClick={() => blocker.proceed()}>放弃修改</button>
        <button className="primary" disabled={working} onClick={async () => { if (await save(false, true)) blocker.proceed() }}>保存并离开</button></div>
    </Modal>}
  </>
}

export function AnnotationPage() {
  const client = useClient()
  const { id, status } = useDataset()
  const [params] = useSearchParams()
  const caseId = params.get('caseId')
  const workspace = useResource(() => caseId ? client.getCase(id, caseId) : Promise.resolve(null), id + ':' + (caseId ?? 'new'))
  const docs = useResource(() => client.listDocuments(id), id)
  useEffect(() => {
    const refreshDocuments = () => docs.reload()
    window.addEventListener('focus', refreshDocuments)
    return () => window.removeEventListener('focus', refreshDocuments)
  }, [id])
  if (!docs.data) return <ResourceState state={docs} />
  if (workspace.data === undefined) return <ResourceState state={workspace} />
  return <Workspace key={id + ':' + (caseId ?? 'new')} initial={workspace.data ?? undefined} docs={docs.data}
    reload={docs.reload} datasetId={id} readOnly={status === 'archived'} />
}
