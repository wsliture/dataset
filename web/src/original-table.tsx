import { Fragment } from 'react'
import type { Excerpt, TableContent, TableRow, TableView } from './client'
import { Provenance, useClient, useResource } from './ui'

export function tableIndex(tables: TableView[] = []) {
  return new Map(tables.map(table => [table.sliceId, table]))
}

export function useTableViews(datasetId: string, excerpts: Excerpt[]) {
  const client = useClient()
  const tableExcerpts = excerpts.filter(slice => /::table-\d+(?: \/ 第 \d+ 行)?$/.test(slice.sourceRef))
  const documents = [...new Set(tableExcerpts.map(slice => slice.documentId))].sort()
  const versions = tableExcerpts.map(slice => slice.version ?? '').join(',')
  const resource = useResource(() => Promise.all(documents.map(doc => client.listTables(datasetId, doc).catch(() => []))),
    datasetId + ':' + documents.join(',') + ':' + versions)
  return tableIndex(resource.data?.flat())
}

export function TableExcerpt({ slice, views }: { slice: Excerpt; views: Map<string, TableView> }) {
  const whole = views.get(slice.sliceId)
  const table = whole ?? [...views.values()].find(view => view.rows.some(row => row.sliceId === slice.sliceId))
  const index = table?.rows.findIndex(row => row.sliceId === slice.sliceId) ?? -1
  const context = (index >= 0 ? table?.rows[index].sharedContext : undefined) ?? slice.sharedContext
  return <>
    {table ? <>
      <p className="muted">{whole ? '已选整表' : '仅选中第 ' + (index + 1) + ' 行（高亮）'}</p>
      <OriginalTable table={table} slices={[slice]} matches={whole ? undefined : new Set([slice.sliceId])} />
      {whole && (slice.version ?? 1) > 1 && <details><summary>查看修订后的整表文本</summary><p>{slice.text}</p></details>}
    </> : <p>{slice.text}</p>}
    {context?.map(text => <p key={text}>共享条件：{text}</p>)}
    <Provenance slice={slice} />
  </>
}

export function TableExcerpts({ slices, views }: { slices: Excerpt[]; views: Map<string, TableView> }) {
  return slices.length ? <div className="excerpts">{slices.map(slice => <article key={slice.sliceId}>
    <TableExcerpt slice={slice} views={views} />
  </article>)}</div> : <p className="muted">暂无切片</p>
}

function Cells({ parts }: { parts: TableContent[] }) {
  return parts.map((part, index) => <Fragment key={index}>{
    typeof part === 'string' ? part : part.kind === 'break' ? <br /> :
      <table className="original-table-grid"><tbody>{part.rows.map((row, i) => <tr key={i}><RowCells row={row} /></tr>)}</tbody></table>
  }</Fragment>)
}

function RowCells({ row }: { row: TableRow }) {
  return row.cells.map((cell, index) => {
    const Tag = cell.header ? 'th' : 'td'
    return <Tag key={index} rowSpan={cell.rowSpan} colSpan={cell.colSpan}><Cells parts={cell.content} /></Tag>
  })
}

export function OriginalTable<T extends Excerpt>({ table, slices, selected, matches, onSelect, onEdit, readOnly }: {
  table: TableView; slices: T[]; selected?: string[]; matches?: Set<string>;
  onSelect?: (slice: T) => void; onEdit?: (slice: T) => void; readOnly?: boolean
}) {
  const byId = new Map(slices.map(slice => [slice.sliceId, slice]))
  const parent = byId.get(table.sliceId)
  const checked = (slice: T) => selected?.includes(slice.sliceId) ?? false
  const controls = Boolean(onSelect || onEdit)
  return <section className="original-table">
    <div className="row spread"><strong>{table.title || '表格'}</strong><span className="muted">原表</span></div>
    {parent && onSelect && <label className="row"><input type="checkbox" checked={checked(parent)}
      disabled={readOnly} onChange={() => onSelect(parent)} />选中整表</label>}
    <div className="table-wrap"><table className="original-table-grid" aria-label={table.title || '原表'}><tbody>
      {table.rows.map((row, index) => {
        const slice = row.sliceId ? byId.get(row.sliceId) : undefined
        return <tr key={index} className={slice && matches?.has(slice.sliceId) ? 'table-row-match' : undefined}>
          {controls && <td className="table-row-controls">
            {slice && onSelect && <input type="checkbox" aria-label={'选择第 ' + (index + 1) + ' 行'}
              checked={checked(slice)} disabled={readOnly} onChange={() => onSelect(slice)} />}
            {slice && onEdit && <button className="text-button" onClick={() => onEdit(slice)}>编辑第 {index + 1} 行</button>}
          </td>}
          <RowCells row={row} />
        </tr>
      })}
    </tbody></table></div>
    {table.rows.flatMap((row, index) => {
      const slice = row.sliceId ? byId.get(row.sliceId) : undefined
      return slice && (slice.version ?? 1) > 1 ? [<div className="table-revision" key={slice.sliceId}>
        <strong>第 {index + 1} 行 · 已修订</strong><p>{slice.text}</p>
      </div>] : []
    })}
  </section>
}
