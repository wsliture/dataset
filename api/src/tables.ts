import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import type { Database, Excerpt, Slice } from './repository.js'
import { sliceFields } from './repository.js'

type Node = DefaultTreeAdapterMap['childNode']
type Element = DefaultTreeAdapterMap['element']
export type Content = string | { kind: 'break' } | { kind: 'table'; rows: TableRow[] }
interface TableCell { rowSpan: number; colSpan: number; header: boolean; content: Content[] }
interface TableRow { cells: TableCell[]; sliceId?: string; sharedContext?: string[] }

function named(node: Node, ...tags: string[]): node is Element {
  return 'tagName' in node && tags.includes(node.tagName)
}

function span(node: Element, name: string) {
  const value = Number(node.attrs.find(attr => attr.name === name)?.value ?? 1)
  return Number.isInteger(value) && value >= 1 && value <= 1000 ? value : 1
}

function content(nodes: Node[]): Content[] {
  return nodes.flatMap((node): Content[] => {
    if ('value' in node) return [node.value]
    if (named(node, 'br')) return [{ kind: 'break' }]
    if (named(node, 'table')) return [{ kind: 'table', rows: rows(node) }]
    return []
  })
}

function rows(table: Element): TableRow[] {
  return table.childNodes.flatMap(node => named(node, 'thead', 'tbody', 'tfoot') ? node.childNodes : [node])
    .filter(node => named(node, 'tr')).map(row => ({
      cells: row.childNodes.filter(cell => named(cell, 'td', 'th')).map(cell => ({
        rowSpan: span(cell, 'rowspan'), colSpan: span(cell, 'colspan'), header: cell.tagName === 'th',
        content: content(cell.childNodes),
      })),
    }))
}

function plain(parts: Content[]): string {
  return parts.map(part => typeof part === 'string' ? part : part.kind === 'break' ? '\n' :
    part.rows.map(row => row.cells.map(cell => plain(cell.content)).join(' | ')).join('\n')).join('').trim()
}

export function sharedTableContext(tableRows: TableRow[]) {
  const context = tableRows.map(() => [] as string[])
  for (const [index, row] of tableRows.entries()) {
    for (const cell of row.cells) {
      if (cell.rowSpan === 1) continue
      const text = plain(cell.content)
      if (!text) continue
      for (let i = index + 1; i < Math.min(tableRows.length, index + cell.rowSpan); i++) {
        if (!context[i].includes(text)) context[i].push(text)
      }
    }
  }
  return context
}

export function parseTable(html: string) {
  const table = parseFragment(html).childNodes.find(node => named(node, 'table'))
  return table ? rows(table) : []
}

export async function tableViews(root: string, documentId: string, slices: Slice[]) {
  if (!slices.some(slice => slice.kind === 'table')) return []
  try {
    const structure = JSON.parse(await readFile(join(root, documentId, 'document-structure.json'), 'utf8')) as {
      sections: { tables: { table_id: string; table_html: string; title: string }[] }[]
    }
    const tables = new Map(structure.sections.flatMap(section => section.tables.map(table => [table.table_id, table] as const)))
    return slices.flatMap(slice => {
      if (slice.kind !== 'table') return []
      const original = tables.get(slice.sourceRef)
      if (typeof original?.table_html !== 'string') return []
      const tableRows = parseTable(original.table_html)
      const children = slices.filter(row => row.parentSliceId === slice.sliceId)
      if (!tableRows.length || children.some(row => !row.rowOrder || row.rowOrder > tableRows.length)) return []
      const byOrder = new Map(children.map(row => [row.rowOrder, row]))
      const contexts = sharedTableContext(tableRows)
      return [{ sliceId: slice.sliceId, title: typeof original.title === 'string' ? original.title : '',
        rows: tableRows.map((row, index) => {
          const child = byOrder.get(index + 1)
          if (!child) return row
          const sharedContext = contexts[index].filter(text => !containsContext(child.text, text))
          return { ...row, sliceId: child.sliceId, ...(sharedContext.length ? { sharedContext } : {}) }
        }) }]
    })
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function containsContext(body: string, context: string) {
  const compact = (text: string) => text.replace(/\s+/g, '')
  const values = body.replace(/(^|\n| \| )[^：\n|]+：/g, '$1')
  return compact(values).includes(compact(context)) ||
    compact(body).includes(compact('共享条件：' + context))
}

export async function documentTableViews(db: Database, root: string, datasetId: string, ids: string[]) {
  if (!ids.length) return new Map<string, Awaited<ReturnType<typeof tableViews>>>()
  const { rows } = await db.query<Slice>(`SELECT ${sliceFields}
    FROM slices s JOIN documents d ON d.id=s.document_id
    WHERE d.dataset_id=$1 AND d.id=ANY($2::uuid[]) AND s.kind IN ('table','table_row')`, [datasetId, ids])
  const grouped = new Map<string, Slice[]>()
  for (const row of rows) {
    const group = grouped.get(row.documentId) ?? []
    group.push(row)
    grouped.set(row.documentId, group)
  }
  return new Map(await Promise.all([...grouped].map(async ([id, slices]) => [id, await tableViews(root, id, slices)] as const)))
}

export async function enrichCaseTables<T extends { sourceSlices: Excerpt[]; testRequirementSlices: Excerpt[] }>(
  db: Database, root: string, datasetId: string, cases: T[],
): Promise<T[]> {
  const ids = [...new Set(cases.flatMap(item => [...item.sourceSlices, ...item.testRequirementSlices]
    .filter(slice => / \/ 第 \d+ 行$/.test(slice.sourceRef)).map(slice => slice.documentId)))]
  const tables = await documentTableViews(db, root, datasetId, ids)
  const contexts = new Map<string, string[]>()
  for (const views of tables.values()) {
    for (const table of views) for (const row of table.rows) {
      if (row.sliceId && row.sharedContext?.length) contexts.set(row.sliceId, row.sharedContext)
    }
  }
  const enrich = (slice: Excerpt) => {
    const sharedContext = contexts.get(slice.sliceId)?.filter(text => !containsContext(slice.text, text))
    return sharedContext?.length ? { ...slice, sharedContext } : slice
  }
  return cases.map(item => ({ ...item, sourceSlices: item.sourceSlices.map(enrich),
    testRequirementSlices: item.testRequirementSlices.map(enrich) }))
}
