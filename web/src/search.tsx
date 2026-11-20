
import { useState, useRef, createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { ArrowUp, MessageSquareText } from 'lucide-react'
import { CaseDetailDialog } from './case-detail'
import type { SearchResult } from './client'
import { messageOf, stripResults } from './client'
import { TableExcerpts, useTableViews } from './original-table'
import { Empty, ErrorText, useClient } from './ui'

type Turn = { id: string; query: string; results?: SearchResult[]; error?: string; removed?: boolean }
function useSearchSession() {
  const client = useClient()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const deleted = useRef(new Set<string>())
  const pending = useRef(false)

  function dropDataset(id: string) {
    deleted.current.add(id)
    setTurns(previous => previous.map(turn => {
      if (!turn.results?.some(result => result.datasetId === id)) return turn
      const results = stripResults(turn.results, deleted.current)
      return { ...turn, results, removed: !results.length }
    }))
  }
  async function send(raw = input, retryId?: string) {
    if (pending.current) return
    const query = raw.trim()
    if (!query) { setError('请输入源需求、设计描述或接口标识。'); return }
    const turn = { id: retryId ?? crypto.randomUUID(), query }
    const update = (value: Turn) => setTurns(previous => previous.map(item => item.id === value.id ? value : item))
    setError('')
    pending.current = true
    setBusy(true)
    if (retryId) update(turn)
    else setTurns(previous => [...previous, turn])
    try {
      const response = await client.search({ query })
      const results = stripResults(response.results, deleted.current)
      update({ ...turn, results, removed: response.results.length > 0 && !results.length })
      setInput('')
    } catch (failure) {
      update({ ...turn, error: messageOf(failure) })
      setInput(query)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return { turns, input, setInput, busy, error, send, dropDataset }
}
const Context = createContext<ReturnType<typeof useSearchSession> | null>(null)
export const useChat = () => useContext(Context)!
export function ChatProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useSearchSession()}>{children}</Context.Provider>
}

export function SearchPage() {
  const chat = useChat()
  const [detail, setDetail] = useState<SearchResult>()
  return <main className="container search-page">
    <div className="page-head"><div><h1>案例检索</h1><p>输入源需求、设计描述或接口标识，查找已确认的历史配对。</p></div></div>
    <section className="panel chat">
      <div className="chat-log" aria-live="polite" aria-busy={chat.busy}>
        {!chat.turns.length && <div className="chat-start"><span className="empty-icon"><MessageSquareText size={26} /></span>
          <h2>查找相似历史案例</h2><p>从案例中核对历史源文、测试需求及其出处。</p></div>}
        {chat.turns.map(turn => <section className="turn" key={turn.id}>
          <p className="bubble">{turn.query}</p>
          {turn.error ? <div className="turn-feedback"><ErrorText error={turn.error} /><button disabled={chat.busy} onClick={() => chat.send(turn.query, turn.id)}>重试查询</button></div>
            : !turn.results ? <p className="muted" role="status">正在查询…</p>
            : !turn.results.length ? <Empty title={turn.removed ? '相关数据集已删除' : '没有匹配的案例'} />
            : <><p className="result-count">{turn.results.length} 条匹配案例</p>{turn.results.map(item =>
              <SearchResultCard key={item.caseId} item={item} open={() => setDetail(item)} />)}</>}
        </section>)}
      </div>
      <form className="composer" onSubmit={event => { event.preventDefault(); void chat.send() }}>
        <div className="composer-row"><textarea aria-label="查询内容" placeholder="输入源需求、设计描述或接口标识"
          value={chat.input} disabled={chat.busy} rows={2} onChange={event => chat.setInput(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void chat.send() } }} />
          <button className="primary" type="submit" disabled={chat.busy}><ArrowUp size={17} />{chat.busy ? '查询中' : '发送'}</button></div>
        <ErrorText error={chat.error} />
      </form>
    </section>
    {detail && <CaseDetailDialog id={detail.datasetId} caseId={detail.caseId} close={() => setDetail(undefined)} />}
  </main>
}

function SearchResultCard({ item, open }: { item: SearchResult; open: () => void }) {
  const views = useTableViews(item.datasetId, [...item.matchedSourceSlices, ...item.testRequirementSlices])
  return <article className="result-card">
    <header><div><span className="muted">{item.datasetName}</span><h3>{item.caseTitle}</h3></div>
      <button onClick={open}>查看案例详情</button></header>
    <div className="split"><section><h4>命中源切片</h4><TableExcerpts slices={item.matchedSourceSlices} views={views} /></section>
      <section><h4>关联测试需求</h4><TableExcerpts slices={item.testRequirementSlices} views={views} /></section></div>
  </article>
}
