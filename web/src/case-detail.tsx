import { sideNames } from './client'
import { TableExcerpts, useTableViews } from './original-table'
import { Badge, dateText, Modal, ResourceState, useClient, useResource } from './ui'

export function CaseDetailDialog({ id, caseId, close }: { id: string; caseId: string; close: () => void }) {
  const client = useClient()
  const state = useResource(() => client.getCase(id, caseId), id + ':' + caseId)
  const item = state.data
  const views = useTableViews(id, item ? [...item.sourceSlices, ...item.testRequirementSlices] : [])
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
      <div className="split"><section><h3>{sideNames.source} · {item.sourceSlices.length}</h3><TableExcerpts slices={item.sourceSlices} views={views} /></section>
        <section><h3>{sideNames.test_requirement} · {item.testRequirementSlices.length}</h3><TableExcerpts slices={item.testRequirementSlices} views={views} /></section></div>
    </> : <ResourceState state={state} />}
  </Modal>
}
