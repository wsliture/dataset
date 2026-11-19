
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { X, FileText, Layers3 } from 'lucide-react'
import { messageOf, statusNames } from './client'
import type { DatasetClient, Excerpt, Status } from './client'

export const ClientContext = createContext<DatasetClient | null>(null)
export const useClient = () => useContext(ClientContext)!
export function useResource<T>(load: () => Promise<T>, key: string) {
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<{ key: string; data?: T; error?: string; busy: boolean }>({ key, busy: true })
  useEffect(() => {
    let current = true
    setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, busy: true }))
    load().then(data => { if (current) setState({ key, data, busy: false }) },
      error => { if (current) setState({ key, error: messageOf(error), busy: false }) })
    return () => { current = false }
  }, [key, refresh])
  return { ...(state.key === key ? state : { key, busy: true }), reload: () => setRefresh(value => value + 1) }
}

export function ErrorText({ error }: { error?: string }) {
  return error ? <p className="error" role="alert">{error}</p> : null
}

export function ResourceState({ state }: { state: { busy: boolean; error?: string; reload: () => void } }) {
  if (state.error) return <div className="panel state"><ErrorText error={state.error} /><button onClick={state.reload}>重试</button></div>
  if (state.busy) return <div className="panel state" role="status">正在加载…</div>
  return null
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Layers3 size={22} /></span><strong>{title}</strong>{children && <div>{children}</div>}</div>
}

export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useRef(crypto.randomUUID())
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => { dialog.close(); previous?.focus() }
  }, [])
  return <dialog ref={ref} className={wide ? 'dialog wide' : 'dialog'} aria-labelledby={titleId.current}
    onCancel={event => { event.preventDefault(); close() }}>
    <header><h2 id={titleId.current}>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={19} /></button></header>
    <div className="dialog-body">{children}</div>
  </dialog>
}

export function Confirm({ title, children, confirm, close, label = '删除', danger = true }: {
  title: string; children: ReactNode; confirm: () => Promise<void>; close: () => void; label?: string; danger?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit() {
    setBusy(true)
    setError('')
    try { await confirm(); close() } catch (failure) { setError(messageOf(failure)) } finally { setBusy(false) }
  }
  return <Modal title={title} close={() => { if (!busy) close() }}>
    {children}<ErrorText error={error} />
    <footer className="actions"><button disabled={busy} onClick={close}>取消</button>
      <button className={danger ? 'danger' : 'primary'} disabled={busy} onClick={submit}>{busy ? '处理中…' : label}</button></footer>
  </Modal>
}

export function Badge({ status }: { status: Status }) {
  const name = statusNames[status]
  return <span className={'badge ' + status}><i />{name}</span>
}
export function Provenance({ slice }: { slice: Excerpt }) {
  return <span className="provenance"><FileText size={13} />{[slice.documentName, ...slice.sectionPath, slice.sourceRef].join(' · ')}</span>
}
export function Excerpts({ slices }: { slices: Excerpt[] }) {
  return slices.length ? <div className="excerpts">{slices.map(slice => <article key={slice.sliceId}>
    <p>{slice.text}</p><Provenance slice={slice} />
  </article>)}</div> : <p className="muted">暂无切片</p>
}
export const dateText = (value: string) => new Intl.DateTimeFormat('sv-SE').format(new Date(value))
