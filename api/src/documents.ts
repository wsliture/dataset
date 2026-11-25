import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyRequest } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import type { Config } from './config.js'
import { ApiError, conflict, invalid, missing, normalize, read, side, uuid, type Side } from './contract.js'
import { checkEmbeddingRevision, transaction } from './db.js'
import { parseDocx } from './docx.js'
import { tokens, vectorLiteral } from './indexing.js'
import { dataset, publicSlice, sliceFields, touch, type Database, type Slice } from './repository.js'
import type { Embed } from './cases.js'

interface DocumentRow { id: string; datasetId: string; name: string; type: Side; warnings: string[]; importedAt: Date }
const columns = 'd.id,d.dataset_id "datasetId",d.name,d.type,d.warnings,d.imported_at "importedAt"'

export async function documents(db: Database, datasetId: string, id?: string) {
  const { rows } = await db.query<DocumentRow>(
    `SELECT ${columns} FROM documents d WHERE d.dataset_id=$1 AND ($2::uuid IS NULL OR d.id=$2)
    ORDER BY d.imported_at,d.id`, [datasetId, id ?? null])
  if (id && !rows.length) missing()
  const { rows: slices } = await db.query<Slice>(
    `SELECT ${sliceFields} FROM slices s JOIN documents d ON d.id=s.document_id
    WHERE d.dataset_id=$1 AND ($2::uuid IS NULL OR d.id=$2) ORDER BY s.document_id,s.position`, [datasetId, id ?? null])
  const grouped = new Map<string, Slice[]>()
  for (const slice of slices) {
    if (!grouped.has(slice.documentId)) grouped.set(slice.documentId, [])
    grouped.get(slice.documentId)!.push(publicSlice(slice))
  }
  return rows.map(row => ({ ...row, slices: grouped.get(row.id) ?? [] }))
}

export async function listDocuments(pool: Pool, datasetId: string, id?: string) {
  return transaction(pool, async db => {
    await dataset(db, datasetId)
    return documents(db, datasetId, id)
  }, true)
}

async function lockFiles(db: PoolClient, id: string, wait: boolean) {
  const fn = wait ? 'pg_advisory_lock' : 'pg_try_advisory_lock'
  const { rows } = await db.query<{ acquired: boolean }>(`SELECT ${fn}(hashtextextended($1,1)) acquired`, [id])
  return wait || rows[0].acquired
}
async function unlockFiles(db: PoolClient, id: string) {
  await db.query('SELECT pg_advisory_unlock(hashtextextended($1,1))', [id])
}
const stagingPath = (root: string, id: string) => join(root, '.staging', id)

export async function importDocument(pool: Pool, config: Config, datasetId: string, request: FastifyRequest) {
  const id = randomUUID()
  const root = config.DOCUMENT_ROOT
  const stage = stagingPath(root, id)
  const final = join(root, id)
  const source = join(stage, 'original.docx')
  const db = await pool.connect()
  let locked = false
  let discard = false
  let moved = false
  let committing = false
  let committed = false
  try {
    locked = await lockFiles(db, id, true)
    const owner = await dataset(db, datasetId)
    if (owner.status === 'archived') throw new ApiError(409, 'DATASET_ARCHIVED', '归档数据集只允许查看。')
    await mkdir(stage, { recursive: true })
    let type: Side | undefined
    let name: string | undefined
    for await (const part of request.parts()) {
      if (part.type === 'field' && part.fieldname === 'type' && !type) {
        type = read(side, part.value)
      } else if (part.type === 'file' && part.fieldname === 'file' && !name) {
        name = basename(part.filename.replaceAll('\\', '/')).trim()
        if (!/\.docx$/i.test(name)) invalid('请选择 DOCX 文件。')
        await pipeline(part.file, createWriteStream(source, { flags: 'wx' }))
        if (part.file.truncated) throw new ApiError(413, 'DOCX_TOO_LARGE', 'DOCX 上传大小超限。')
      } else invalid('上传仅接受 type 和 file 各一项。')
    }
    if (!type || !name) invalid('请提供 DOCX 文件与文档类型。')
    if (!(await stat(source)).size) throw new ApiError(400, 'DOCX_EMPTY', '上传文件为空。')
    const parsed = await parseDocx(source, config.DOCX_EXPANDED_LIMIT)
    await writeFile(join(stage, 'document-structure.json'), JSON.stringify(parsed.structure, null, 2) + '\n', 'utf8')
    await db.query('BEGIN')
    await dataset(db, datasetId, 'write')
    await db.query('INSERT INTO documents(id,dataset_id,type,name,normalized_name,warnings) VALUES($1,$2,$3,$4,$5,$6)',
      [id, datasetId, type, name, normalize(name), JSON.stringify(parsed.warnings)])
    const rows = parsed.slices.map((slice, position) => {
      const index = type === 'source' ? tokens(slice.text) : { words: [], identifiers: [] }
      return { ...slice, position, words: index.words.join(' '), identifiers: index.identifiers }
    })
    await db.query(`
      INSERT INTO slices(id,document_id,section_id,section_path,position,source_ref,kind,parent_id,row_order,text,terms,identifiers)
      SELECT id,$1,"sectionId","sectionPath",position,"sourceRef",kind,"parentId","rowOrder",text,
        to_tsvector('simple',words),identifiers
      FROM jsonb_to_recordset($2::jsonb) AS row(id uuid,"sectionId" text,"sectionPath" text[],position int,
        "sourceRef" text,kind text,"parentId" uuid,"rowOrder" int,text text,words text,identifiers text[])
    `, [id, JSON.stringify(rows)])
    await touch(db, datasetId)
    const [doc] = await documents(db, datasetId, id)
    await rename(stage, final)
    moved = true
    committing = true
    await db.query('COMMIT')
    committed = true
    return doc
  } catch (error) {
    try { await db.query('ROLLBACK') } catch { discard = true }
    if ((error as { constraint?: string }).constraint === 'documents_dataset_id_type_normalized_name_key') {
      throw new ApiError(409, 'DOCUMENT_NAME_CONFLICT', '本分栏已存在同名文档。')
    }
    throw error
  } finally {
    let safeToRemove = !committed && !committing
    if (!committed && committing && !discard) {
      try {
        const { rowCount } = await db.query('SELECT FROM documents WHERE id=$1', [id])
        safeToRemove = rowCount === 0
      } catch { discard = true }
    }
    if (safeToRemove) {
      // Failed filesystem cleanup is retried by the orphan sweeper.
      await rm(moved ? final : stage, { recursive: true, force: true }).catch(() => {})
    }
    if (locked && !discard) {
      try { await unlockFiles(db, id) } catch { discard = true }
    }
    db.release(discard)
  }
}

export async function deleteDocument(pool: Pool, datasetId: string, id: string) {
  await transaction(pool, async db => {
    await dataset(db, datasetId, 'write')
    const { rowCount } = await db.query('SELECT FROM documents WHERE dataset_id=$1 AND id=$2 FOR UPDATE', [datasetId, id])
    if (!rowCount) missing()
    const { rows } = await db.query<{ id: string; title: string }>(`
      SELECT id,input->>'title' title FROM cases WHERE id IN (
        SELECT r.case_id FROM case_slices r JOIN slices s ON s.id=r.slice_id WHERE s.document_id=$1
        UNION SELECT r.case_id FROM case_revision_slices r JOIN slices s ON s.id=r.slice_id WHERE s.document_id=$1
      ) ORDER BY id`, [id])
    if (rows.length) throw new ApiError(409, 'DOCUMENT_REFERENCED',
      '文档被案例当前或历史版本引用：' + rows.map(row => row.title || '未命名案例').join('、'), { blockingCases: rows })
    await db.query('INSERT INTO file_cleanup_jobs(id) VALUES($1) ON CONFLICT DO NOTHING', [id])
    await db.query('DELETE FROM documents WHERE id=$1', [id])
    await touch(db, datasetId)
  })
}

async function prepareEdit(db: Database, datasetId: string, documentId: string, sliceId: string,
  text: string, version: number, lock = false) {
  const { rows } = await db.query<Slice & { side: Side; position: number }>(`
    SELECT ${sliceFields},d.type side,s.position FROM slices s JOIN documents d ON d.id=s.document_id
    WHERE d.dataset_id=$1 AND d.id=$2 AND (s.id=$3
      OR s.parent_id IN (SELECT parent_id FROM slices WHERE id=$3)
      OR s.id IN (SELECT parent_id FROM slices WHERE id=$3)
      OR s.parent_id=$3)
    ORDER BY s.id ${lock ? 'FOR UPDATE OF s' : ''}`, [datasetId, documentId, sliceId])
  const target = rows.find(row => row.sliceId === sliceId)
  if (!target) missing()
  if (target.version !== version) conflict()
  if (target.kind === 'table' && rows.some(row => row.parentSliceId === sliceId)) invalid('请编辑表格行以更新整表文本。')
  const affected = [{ ...target, text }]
  const parent = rows.find(row => row.sliceId === target.parentSliceId)
  if (parent) affected.push({ ...parent, text: rows.filter(row => row.parentSliceId === parent.sliceId)
    .sort((a, b) => a.position - b.position).map(row => row.sliceId === sliceId ? text : row.text).join('\n') })
  const { rows: referenced } = target.side === 'source' ? await db.query<{ slice_id: string }>(`
    SELECT DISTINCT r.slice_id FROM case_slices r JOIN eligible_cases c ON c.id=r.case_id
    WHERE r.slice_id=ANY($1::uuid[]) AND r.side='source'`, [affected.map(row => row.sliceId)]) : { rows: [] }
  return { affected, referenced: new Set(referenced.map(row => row.slice_id)) }
}

export async function updateSlice(pool: Pool, config: Config, embed: Embed, datasetId: string, documentId: string,
  sliceId: string, text: string, version: number) {
  const prepared = await transaction(pool, async db => {
    const owner = await dataset(db, datasetId)
    if (owner.status === 'archived') throw new ApiError(409, 'DATASET_ARCHIVED', '归档数据集只允许查看。')
    return prepareEdit(db, datasetId, documentId, sliceId, text, version)
  }, true)
  const pending = prepared.affected.filter(row => prepared.referenced.has(row.sliceId))
  const embeddings = await embed(pending.map(row => row.text))
  const vectors = new Map(pending.map((row, index) => [row.sliceId, embeddings[index]]))
  return transaction(pool, async db => {
    await dataset(db, datasetId, 'write')
    const current = await prepareEdit(db, datasetId, documentId, sliceId, text, version, true)
    await checkEmbeddingRevision(db, config.embeddingRevision)
    for (const slice of current.affected) {
      if (prepared.affected.find(row => row.sliceId === slice.sliceId)?.version !== slice.version) conflict()
      const vector = current.referenced.has(slice.sliceId) ? vectors.get(slice.sliceId) : undefined
      if (current.referenced.has(slice.sliceId) && !vector) conflict()
      const index = slice.side === 'source' ? tokens(slice.text) : { words: [], identifiers: [] }
      await db.query(`UPDATE slices SET text=$2,version=version+1,updated_at=clock_timestamp(),
        terms=to_tsvector('simple',$3),identifiers=$4,embedding=$5::vector,embedding_model=$6,
        embedding_version=CASE WHEN $5::vector IS NOT NULL THEN version+1 ELSE NULL END WHERE id=$1`,
      [slice.sliceId, slice.text, index.words.join(' '), index.identifiers,
        vector ? vectorLiteral(vector) : null, vector ? config.EMBEDDING_MODEL : null])
    }
    await touch(db, datasetId)
    return (await documents(db, datasetId, documentId))[0]
  })
}

export async function sweepFiles(pool: Pool, root: string, sweepOrphans: boolean) {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM file_cleanup_jobs WHERE next_attempt<=now() ORDER BY next_attempt LIMIT 100')
  const jobs = new Set(rows.map(row => row.id))
  const candidates = new Set(jobs)
  const grace = Date.now() - 60 * 60 * 1000
  if (sweepOrphans) {
    for (const directory of [root, join(root, '.staging')]) {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (!item.isDirectory() || !uuid.safeParse(item.name).success) continue
        const info = await stat(join(directory, item.name)).catch(() => undefined)
        if (info && info.mtimeMs < grace) candidates.add(item.name)
      }
    }
  }
  for (const id of candidates) {
    const db = await pool.connect()
    let locked = false
    let discard = false
    try {
      locked = await lockFiles(db, id, false)
      if (!locked) continue
      const { rowCount } = await db.query('SELECT FROM documents WHERE id=$1', [id])
      if (rowCount) continue
      await rm(join(root, id), { recursive: true, force: true })
      await rm(stagingPath(root, id), { recursive: true, force: true })
      await db.query('DELETE FROM file_cleanup_jobs WHERE id=$1', [id])
    } catch (error) {
      if (!jobs.has(id)) throw error
      await db.query(`UPDATE file_cleanup_jobs SET attempts=attempts+1,
        next_attempt=now()+make_interval(secs=>least(3600, 10*power(2,least(attempts,9)))::int) WHERE id=$1`, [id])
      throw error
    } finally {
      if (locked) {
        try { await unlockFiles(db, id) } catch { discard = true }
      }
      db.release(discard)
    }
  }
}
