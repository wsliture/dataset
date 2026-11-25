
import { useRef, useState } from 'react'
import { FileText, Upload, Trash2, Pencil } from 'lucide-react'
import { messageOf, sideNames } from './client'
import type { Doc, Side, Slice } from './client'
import { useDataset } from './datasets'
import { createClientId } from './client-id'
import { OriginalTable, tableIndex } from './original-table'
import { Confirm, dateText, Empty, ErrorText, Modal, Provenance, ResourceState, useClient, useResource } from './ui'

type UploadItem = { id: string; file: File; side: Side; phase: 'uploading' | 'parsing' | 'done' | 'failed'; error?: string }

export function groupSlices(slices: Slice[]) {
  const sections = new Map<string, Slice[]>()
  for (const slice of slices) {
    const section = slice.sectionId
    const group = sections.get(section)
    if (group) group.push(slice)
    else sections.set(section, [slice])
  }
  return sections
}

function EditSlice({ slice, save, close }: { slice: Slice; save: (text: string) => Promise<void>; close: () => void }) {
  const [text, setText] = useState(slice.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <Modal title="编辑切片" close={() => { if (!busy) close() }}>
    <Provenance slice={slice} />
    <form className="form-stack" onSubmit={async event => {
      event.preventDefault()
      setBusy(true)
      setError('')
      try { await save(text); close() } catch (failure) { setError(messageOf(failure)) } finally { setBusy(false) }
    }}><label>切片文本<textarea required rows={7} value={text} onChange={event => setText(event.target.value)} /></label>
      <ErrorText error={error} /><footer className="actions"><button type="button" disabled={busy} onClick={close}>取消</button>
        <button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></footer>
    </form>
  </Modal>
}

export function DocumentsPage() {
  const client = useClient()
  const dataset = useDataset()
  const readOnly = dataset.status === 'archived'
  const state = useResource(() => client.listDocuments(dataset.id), dataset.id)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [preview, setPreview] = useState<Doc>()
  const [deleting, setDeleting] = useState<Doc>()
  const [editing, setEditing] = useState<Slice>()
  const tables = useResource(() => preview ? client.listTables(dataset.id, preview.id) : Promise.resolve([]),
    dataset.id + ':' + (preview?.id ?? ''))
  const views = tableIndex(tables.data)
  const sourceFile = useRef<HTMLInputElement>(null)
  const testFile = useRef<HTMLInputElement>(null)

  function update(id: string, phase: UploadItem['phase'], error?: string) {
    setUploads(previous => previous.map(item => item.id === id ? { ...item, phase, error } : item))
  }
  async function upload(item: UploadItem) {
    update(item.id, 'uploading')
    try {
      await client.importDocument(dataset.id, item.side, item.file, () => update(item.id, 'parsing'))
      update(item.id, 'done')
      state.reload()
    } catch (failure) { update(item.id, 'failed', messageOf(failure)) }
  }

  if (!state.data) return <ResourceState state={state} />
  return <>
    <div className="sub-head"><h2>文档管理</h2></div>
    <div className="split document-grid">{(['source', 'test_requirement'] as const).map(side => {
      const documents = state.data!.filter(doc => doc.type === side)
      const picker = side === 'source' ? sourceFile : testFile
      return <section className="panel" key={side}>
        <header className="section-head"><div className="row"><span className="table-icon"><FileText size={18} /></span>
          <div><h3>{sideNames[side]}</h3><p>{documents.length} 份文档</p></div></div>
          {!readOnly && <><button onClick={() => picker.current?.click()}><Upload size={15} />选择 DOCX</button>
            <input hidden ref={picker} type="file" accept=".docx" multiple aria-label={'导入' + sideNames[side]}
              onChange={event => {
                const selected: UploadItem[] = Array.from(event.target.files ?? []).map(file => ({
                  id: createClientId(), file, side, phase: 'uploading',
                }))
                event.target.value = ''
                setUploads(previous => [...previous, ...selected])
                void Promise.all(selected.map(upload))
              }} /></>}
        </header>
        <div className="upload-status" aria-live="polite">{uploads.filter(item => item.side === side).map(item => <div className="upload-item" key={item.id}>
          <strong>{item.file.name}</strong><span>{({ uploading: '上传中…', parsing: '解析中…', done: '已导入', failed: '导入失败' })[item.phase]}</span>
          {item.phase === 'failed' && <><ErrorText error={item.error} /><button onClick={() => upload(item)}>重试导入</button>
            <button onClick={() => setUploads(previous => previous.filter(uploadItem => uploadItem.id !== item.id))}>清除</button></>}
        </div>)}</div>
        {documents.length ? documents.map(doc => <article className="document-item" key={doc.id}>
          <FileText size={19} /><div className="grow"><strong>{doc.name}</strong><p>{doc.slices.length} 个切片 · {dateText(doc.importedAt)}</p></div>
          <button onClick={() => setPreview(doc)}>结构预览</button>
          {!readOnly && <button className="icon-button destructive" aria-label={'删除 ' + doc.name} onClick={() => setDeleting(doc)}><Trash2 size={16} /></button>}
        </article>) : <Empty title="暂无文档" />}
      </section>
    })}</div>
    {preview && !editing && <Modal wide title={preview.name} close={() => setPreview(undefined)}>
      {preview.warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}
      {[...groupSlices(preview.slices)].map(([section, slices]) => <section className="document-section" key={section}>
        <h3>{slices[0].sectionPath.join(' / ')}</h3><div className="excerpts">{slices.filter(slice =>
          !slice.parentSliceId || !views.has(slice.parentSliceId)).map(slice => {
          const table = views.get(slice.sliceId)
          return table ? <OriginalTable key={slice.sliceId} table={table} slices={slices}
            onEdit={readOnly ? undefined : setEditing} /> : <article key={slice.sliceId} className={slice.parentSliceId ? 'nested' : ''}>
          <div className="row spread"><Provenance slice={slice} />{!readOnly && slice.kind !== 'table' &&
            <button className="icon-button" aria-label={'编辑 ' + slice.sourceRef} onClick={() => setEditing(slice)}><Pencil size={15} /></button>}</div>
          <p>{slice.text}</p>
        </article>})}</div></section>)}
    </Modal>}
    {preview && editing && <EditSlice slice={editing} close={() => setEditing(undefined)} save={async text => {
      setPreview(await client.updateSlice(dataset.id, preview.id, editing.sliceId, text, editing.version))
      tables.reload()
      state.reload()
    }} />}
    {deleting && <Confirm title="删除文档" close={() => setDeleting(undefined)} confirm={async () => {
      await client.deleteDocument(dataset.id, deleting.id)
      state.reload()
    }}><p>确定删除「{deleting.name}」及其切片？</p></Confirm>}
  </>
}
