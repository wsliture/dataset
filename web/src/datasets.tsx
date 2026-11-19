
import { useState } from 'react'
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom'
import { Archive, CheckCircle2, Database, FileText, FolderOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import type { Dataset, DatasetInput } from './client'
import { messageOf } from './client'
import { useChat } from './search'
import { Confirm, dateText, Empty, ErrorText, Modal, ResourceState, useClient, useResource } from './ui'

const blank = { name: '', note: '' }
function DatasetForm({ value, save, close }: { value?: Dataset; save: (input: DatasetInput) => Promise<void>; close: () => void }) {
  const [input, setInput] = useState<DatasetInput>(value ? { name: value.name, note: value.note } : blank)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <Modal title={value ? '编辑数据集' : '新建数据集'} close={() => { if (!busy) close() }}>
    <form className="form-stack" onSubmit={async event => {
      event.preventDefault()
      setBusy(true)
      setError('')
      try { await save(input); close() } catch (failure) { setError(messageOf(failure)) } finally { setBusy(false) }
    }}>
      {([['name', '数据集名称'], ['note', '备注']] as const).map(([key, label]) =>
        <label key={key}>{label}{key === 'name' && <span className="required"> *</span>}
          {key === 'note' ? <textarea value={input[key]} onChange={event => setInput({ ...input, [key]: event.target.value })} rows={3} />
            : <input required={key === 'name'} value={input[key]} onChange={event => setInput({ ...input, [key]: event.target.value })} />}
        </label>)}
      <ErrorText error={error} />
      <footer className="actions"><button type="button" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></footer>
    </form>
  </Modal>
}

export function DatasetsPage() {
  const client = useClient()
  const { dropDataset } = useChat()
  const state = useResource(() => client.listDatasets(), 'datasets')
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<Dataset | 'new'>()
  const [deleting, setDeleting] = useState<Dataset>()
  const datasets = state.data ?? []
  const visible = datasets.filter(item => item.name.toLowerCase().includes(filter.trim().toLowerCase()))
  const stats = [
    { name: '历史数据集', value: datasets.length, icon: Database, tone: 'blue' },
    { name: '待确认案例', value: datasets.reduce((count, item) => count + item.cases.draft, 0), icon: FileText, tone: 'amber' },
    { name: '可检索案例', value: datasets.reduce((count, item) => count + item.searchable, 0), icon: CheckCircle2, tone: 'green' },
  ]
  return <main className="container">
    <div className="page-head"><h1>历史数据集</h1>
      <button className="primary" onClick={() => setEditing('new')}><Plus size={17} />新建数据集</button></div>
    {state.data ? <>
      <div className="stats">{stats.map(({ name, value, icon: Icon, tone }) => <article className="panel stat" key={name}>
        <span className={'stat-icon ' + tone}><Icon size={20} /></span><div><span>{name}</span><strong>{value}</strong></div>
      </article>)}</div>
      <section className="panel">
        <div className="section-head">
          <div><h2>数据集列表</h2><p>共 {visible.length} 个数据集</p></div>
          <label className="search-field"><Search size={16} /><input type="search" aria-label="搜索数据集名称" placeholder="搜索数据集名称" value={filter} onChange={event => setFilter(event.target.value)} /></label>
        </div>
        {visible.length ? <div className="table-wrap"><table>
          <thead><tr><th>数据集</th><th>源资料 / 测试需求</th><th>草稿 / 确认 / 停用</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>{visible.map(item => <tr key={item.id}>
            <td><div className="dataset-cell"><span className="table-icon">{item.status === 'archived' ? <Archive size={17} /> : <FolderOpen size={17} />}</span>
              <div><Link className="name" to={'/datasets/' + item.id + '/documents'}>{item.name}</Link></div></div></td>
            <td>{item.documents.source} / {item.documents.test_requirement}</td>
            <td>{item.cases.draft} / {item.cases.published} / {item.cases.withdrawn}</td>
            <td className="nowrap">{dateText(item.updatedAt)}</td>
            <td><div className="row nowrap"><Link className="text-button" to={'/datasets/' + item.id + '/documents'}>打开</Link>
              {item.status === 'active' && <button className="icon-button" title="编辑" aria-label={'编辑 ' + item.name} onClick={() => setEditing(item)}><Pencil size={16} /></button>}
              <button className="icon-button destructive" title="删除" aria-label={'删除 ' + item.name} onClick={() => setDeleting(item)}><Trash2 size={16} /></button></div></td>
          </tr>)}</tbody></table></div> : <Empty title={filter ? '没有符合条件的数据集' : '暂无数据集'} />}
      </section>
    </> : <ResourceState state={state} />}
    {editing && <DatasetForm value={editing === 'new' ? undefined : editing} close={() => setEditing(undefined)}
      save={async input => { await client.saveDataset(input, editing === 'new' ? undefined : editing.id); state.reload() }} />}
    {deleting && <Confirm title="永久删除数据集" close={() => setDeleting(undefined)} confirm={async () => {
      await client.deleteDataset(deleting.id)
      dropDataset(deleting.id)
      state.reload()
    }}><p>确定删除「{deleting.name}」？其文档、切片、案例和历史记录将永久删除，相关检索结果也会移除。</p></Confirm>}
  </main>
}

export function DatasetLayout() {
  const client = useClient()
  const id = useParams().datasetId!
  const state = useResource(() => client.getDataset(id), id)
  if (!state.data) return <main className="container"><ResourceState state={state} /></main>
  const dataset = state.data
  const tabs = [['documents', '文档管理'], ['annotation', '标注工作台'], ['cases', '案例列表']]
  return <main className="container">
    <nav className="breadcrumb" aria-label="面包屑"><Link to="/datasets">历史数据集</Link><span>/</span><span>{dataset.name}</span></nav>
    <div className="page-head dataset-head"><h1>{dataset.name}</h1></div>
    <nav className="tabs" aria-label="数据集导航">{tabs.map(([path, label]) => <NavLink key={path} to={path}>{label}</NavLink>)}</nav>
    <Outlet context={dataset} />
  </main>
}
export const useDataset = () => useOutletContext<Dataset>()
