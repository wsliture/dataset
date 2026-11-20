import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { ApiError, missing, type Side } from './contract.js'
import { transaction } from './db.js'

export type Database = Pool | PoolClient
export interface DatasetRow { id: string; name: string; note: string; status: 'active' | 'archived'; updatedAt: Date }
const datasetColumns = 'id,name,note,status,updated_at AS "updatedAt"'

export async function dataset(db: Database, id: string, mode?: 'write' | 'delete') {
  const { rows: [row] } = await db.query<DatasetRow>(
    'SELECT ' + datasetColumns + ' FROM datasets WHERE id=$1' + (mode ? ' FOR UPDATE' : ''), [id])
  if (!row) missing()
  if (mode === 'write' && row.status === 'archived') {
    throw new ApiError(409, 'DATASET_ARCHIVED', '归档数据集只允许查看。')
  }
  return row
}

export async function touch(db: Database, id: string) {
  await db.query('UPDATE datasets SET updated_at=clock_timestamp() WHERE id=$1', [id])
}

export async function listDatasets(db: Database) {
  const { rows } = await db.query(`
    SELECT ${datasetColumns},
      (SELECT jsonb_build_object('source',count(*) FILTER(WHERE type='source'),
        'test_requirement',count(*) FILTER(WHERE type='test_requirement')) FROM documents WHERE dataset_id=d.id) documents,
      (SELECT jsonb_build_object('draft',count(*) FILTER(WHERE status='draft'),
        'published',count(*) FILTER(WHERE status='published'),
        'withdrawn',count(*) FILTER(WHERE status='withdrawn')) FROM cases WHERE dataset_id=d.id) cases,
      (SELECT count(*)::integer FROM eligible_cases WHERE dataset_id=d.id) searchable
    FROM datasets d ORDER BY updated_at DESC,id`)
  return rows
}

export async function saveDataset(pool: Pool, input: { name: string; note: string }, id?: string) {
  return transaction(pool, async db => {
    if (id) {
      await dataset(db, id, 'write')
      const { rows } = await db.query<DatasetRow>(
        'UPDATE datasets SET name=$2,note=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING ' + datasetColumns,
        [id, input.name, input.note])
      return rows[0]
    }
    const { rows } = await db.query<DatasetRow>('INSERT INTO datasets(id,name,note) VALUES($1,$2,$3) RETURNING ' + datasetColumns,
      [randomUUID(), input.name, input.note])
    return rows[0]
  })
}

export async function deleteDataset(pool: Pool, id: string) {
  await transaction(pool, async db => {
    await dataset(db, id, 'delete')
    await db.query('INSERT INTO file_cleanup_jobs(id) SELECT id FROM documents WHERE dataset_id=$1 ON CONFLICT DO NOTHING', [id])
    // Remove the referencing rows before cascading the documents and their slices.
    await db.query('DELETE FROM cases WHERE dataset_id=$1', [id])
    await db.query('DELETE FROM datasets WHERE id=$1', [id])
  })
}

export interface Excerpt {
  sliceId: string; text: string; documentId: string; documentName: string; sectionPath: string[]; sourceRef: string
}
export interface Slice extends Excerpt {
  sectionId: string
  kind: 'paragraph' | 'clause' | 'table' | 'table_row'
  parentSliceId?: string | null
  rowOrder?: number | null
  version: number
}
export interface SliceRow extends Slice {
  datasetId: string
  side: Side
  indexed: boolean
}
export const sliceFields = `s.id "sliceId",s.document_id "documentId",d.name "documentName",
s.section_id "sectionId",s.section_path "sectionPath",s.source_ref "sourceRef",s.text,s.kind,s.parent_id "parentSliceId",s.row_order "rowOrder",s.version`
export function excerpt({ sliceId, text, documentId, documentName, sectionPath, sourceRef }: Excerpt): Excerpt {
  return { sliceId, text, documentId, documentName, sectionPath, sourceRef }
}
export function publicSlice(row: Slice): Slice {
  const { kind, version, sectionId, parentSliceId, rowOrder } = row
  return { ...excerpt(row), kind, version, sectionId, ...(parentSliceId && rowOrder ? { parentSliceId, rowOrder } : {}) }
}

export async function slicesByIds(db: Database, ids: string[], lock = false, model = '', dimension = 0) {
  const { rows } = await db.query<SliceRow>(`
    SELECT ${sliceFields},d.dataset_id "datasetId",d.type side,
      coalesce(s.embedding_model=$2 AND s.embedding_version=s.version AND vector_dims(s.embedding)=$3,false) indexed
    FROM slices s JOIN documents d ON d.id=s.document_id WHERE s.id=ANY($1::uuid[])
    ORDER BY s.id ${lock ? 'FOR UPDATE OF s' : ''}`, [ids, model, dimension])
  return new Map(rows.map(row => [row.sliceId, row]))
}
