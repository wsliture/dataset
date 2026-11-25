import { useState } from 'react'
import type { EmbeddingSettings } from './client'
import { ClientError, messageOf } from './client'
import { ErrorText, ResourceState, useClient, useResource } from './ui'

function SettingsForm({ initial, reload }: { initial: EmbeddingSettings; reload: () => void }) {
  const client = useClient()
  const [active, setActive] = useState(initial)
  const [endpoint, setEndpoint] = useState(initial.api_base)
  const [model, setModel] = useState(initial.model_name)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save'>()
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const keepKey = endpoint === active.api_base && active.has_api_key
  const valid = Boolean(endpoint.trim() && model.trim())

  async function submit(action: 'test' | 'save') {
    if (busy || !valid || stale) return
    setBusy(action)
    setError('')
    setNotice('')
    const input = {
      api_base: endpoint.trim(), model_name: model.trim(), revision: active.revision,
      api_key: clearKey ? null : key.trim() || undefined,
    }
    try {
      if (action === 'test') {
        const { dimension } = await client.testEmbeddingSettings(input)
        setNotice(`连接成功，返回 ${dimension} 维向量。`)
      } else {
        const saved = await client.saveEmbeddingSettings(input)
        setActive(saved)
        setEndpoint(saved.api_base)
        setModel(saved.model_name)
        setKey('')
        setClearKey(false)
        setNotice('模型设置已生效。')
      }
    } catch (failure) {
      setError(messageOf(failure))
      setStale(failure instanceof ClientError && failure.code === 'EMBEDDING_SETTINGS_CHANGED')
    } finally { setBusy(undefined) }
  }

  return <section className="panel embedding-settings">
    <form className="form-stack" onChange={() => { setNotice(''); setError('') }}
      onSubmit={event => { event.preventDefault(); void submit('save') }}>
      <label>接口地址（api_base）
        <input type="url" required maxLength={2048} value={endpoint} disabled={Boolean(busy)}
          placeholder="http://bge-m3.intranet:7997/v1/embeddings" onChange={event => {
            setEndpoint(event.target.value)
            setKey('')
            setClearKey(false)
          }} />
      </label>
      <label>模型名称（model_name）
        <input required maxLength={256} disabled={Boolean(busy)} value={model} onChange={event => setModel(event.target.value)} />
      </label>
      <label>API 密钥（api_key）
        <input type="password" autoComplete="new-password" maxLength={4096} value={key}
          disabled={Boolean(busy) || clearKey} placeholder={keepKey ? '已设置，留空保留' : '可选'}
          onChange={event => setKey(event.target.value)} />
      </label>
      {keepKey && <label className="embedding-clear-key"><input type="checkbox" checked={clearKey} disabled={Boolean(busy)}
        onChange={event => { setClearKey(event.target.checked); setKey('') }} />清除已保存的密钥</label>}
      <ErrorText error={error} />
      {notice && <p role="status">{notice}</p>}
      {busy === 'save' && <p role="status">正在验证配置，切换模型时会重建案例向量。</p>}
      <footer className="actions">
        {stale && <button type="button" onClick={reload}>重新加载</button>}
        <button type="button" disabled={Boolean(busy) || !valid || stale} onClick={() => void submit('test')}>
          {busy === 'test' ? '测试中…' : '测试连接'}</button>
        <button className="primary" disabled={Boolean(busy) || !valid || stale}>{busy === 'save' ? '保存中…' : '保存'}</button>
      </footer>
    </form>
  </section>
}

export function EmbeddingSettingsPage() {
  const client = useClient()
  const state = useResource(() => client.getEmbeddingSettings(), 'embedding-settings')
  return <main className="container">
    <div className="page-head"><h1>模型设置</h1></div>
    {state.busy || !state.data ? <ResourceState state={state} /> : <SettingsForm initial={state.data} reload={state.reload} />}
  </main>
}
