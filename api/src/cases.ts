import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { Config } from './config.js'
import { ApiError, conflict, invalid, missing, normalize, stateConflict, type CaseInput, type Filters } from './contract.js'
import { transaction } from './db.js'
import { enrichCaseTables } from './tables.js'
import { vectorLiteral, tokens } from './indexing.js'
import { dataset, excerpt, slicesByIds, touch, type Database, type Excerpt, type SliceRow } from './repository.js'

type Status = 'draft' | 'published' | 'withdrawn'
interface CaseRow { id: string; datasetId: string; input: CaseInput; version: number; status: Status; updatedAt: Date }
const columns = 'id,dataset_id "datasetId",input,version,status,updated_at "updatedAt"'
export type Embed = (texts: string[]) => Promise<number[][]>

async function record(db: Database, datasetId: string, id: string, lock = false) {
  const { rows: [row] } = await db.query<CaseRow>(
    'SELECT ' + columns + ' FROM cases WHERE dataset_id=$1 AND id=$2' + (lock ? ' FOR UPDATE' : ''), [datasetId, id])
  if (!row) missing()
  return row
}

function ids(input: CaseInput) { return [...input.sourceSliceIds, ...input.testRequirementSliceIds] }
function refsValid(input: CaseInput, datasetId: string, slices: Map<string, SliceRow>) {
  const all = ids(input)
  const selected = new Set(all)
  return selected.size === all.length && all.every(id => {
    const slice = slices.get(id)
    return slice?.datasetId === datasetId &&
      (slice.side === 'source' ? input.sourceSliceIds : input.testRequirementSliceIds).includes(id) &&
      (!slice.parentSliceId || !selected.has(slice.parentSliceId))
  })
}
function complete(input: CaseInput) {
  return Boolean(input.title.trim() && input.testObject.trim() && input.categories.length &&
    input.sourceSliceIds.length && input.testRequirementSliceIds.length)
}
function validateReferences(input: CaseInput, datasetId: string, slices: Map<string, SliceRow>) {
  if (!refsValid(input, datasetId, slices)) invalid('切片已失效、重复、不属于对应分栏，或同时选中了整表及其所属行。')
}
function detail(row: CaseRow, slices: Map<string, SliceRow>) {
  const { input, ...fields } = row
  const lookup = (ids: string[]): Excerpt[] => ids.flatMap(id => {
    const slice = slices.get(id)
    return slice?.datasetId === row.datasetId ? [excerpt(slice)] : []
  })
  return { ...fields, ...input, sourceSlices: lookup(input.sourceSliceIds), testRequirementSlices: lookup(input.testRequirementSliceIds),
    valid: complete(input) && refsValid(input, row.datasetId, slices) }
}
export async function getCase(pool: Pool, datasetId: string, id: string, documentRoot: string) {
  return transaction(pool, async db => {
    const row = await record(db, datasetId, id)
    const slices = await slicesByIds(db, ids(row.input))
    const [result] = await enrichCaseTables(db, documentRoot, datasetId, [detail(row, slices)])
    const withVersion = (slice: Excerpt) => ({ ...slice, version: slices.get(slice.sliceId)?.version })
    return { ...result, sourceSlices: result.sourceSlices.map(withVersion),
      testRequirementSlices: result.testRequirementSlices.map(withVersion) }
  }, true)
}

async function snapshot(db: PoolClient, id: string) {
  await db.query(`
    INSERT INTO case_revisions SELECT id,version,input,status,updated_at FROM cases WHERE id=$1`, [id])
  await db.query(`
    INSERT INTO case_revision_slices(case_id,version,slice_id,side,position)
    SELECT r.case_id,c.version,r.slice_id,r.side,r.position FROM case_slices r JOIN cases c ON c.id=r.case_id WHERE c.id=$1`, [id])
}

export async function saveCase(pool: Pool, datasetId: string, input: CaseInput, existing?: { id: string; version: number }) {
  return transaction(pool, async db => {
    await dataset(db, datasetId, 'write')
    const id = existing?.id ?? randomUUID()
    if (existing && (await record(db, datasetId, id, true)).version !== existing.version) conflict()
    const slices = await slicesByIds(db, ids(input))
    validateReferences(input, datasetId, slices)
    const { rows: [row] } = existing
      ? await db.query<CaseRow>(`UPDATE cases SET input=$2,status='draft',version=version+1,
        updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`, [id, input])
      : await db.query<CaseRow>(`INSERT INTO cases(id,dataset_id,input) VALUES($1,$2,$3) RETURNING ${columns}`, [id, datasetId, input])
    await db.query('DELETE FROM case_slices WHERE case_id=$1', [id])
    await db.query(`
      INSERT INTO case_slices(case_id,slice_id,side,position)
      SELECT $1::uuid,slice_id,'source',position FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(slice_id,position)
      UNION ALL SELECT $1::uuid,slice_id,'test_requirement',position FROM unnest($3::uuid[]) WITH ORDINALITY AS selected(slice_id,position)
    `, [id, input.sourceSliceIds, input.testRequirementSliceIds])
    await snapshot(db, id)
    await touch(db, datasetId)
    return detail(row, slices)
  })
}

export async function changeCaseStatus(pool: Pool, config: Config, embed: Embed,
  datasetId: string, id: string, version: number, publish: boolean) {
  const model = config.EMBEDDING_MODEL
  const dimension = config.EMBEDDING_DIMENSION
  const prepared = publish ? await transaction(pool, async db => {
    const owner = await dataset(db, datasetId)
    if (owner.status === 'archived') {
      throw new ApiError(409, 'DATASET_ARCHIVED', '归档数据集只允许查看。')
    }
    const row = await record(db, datasetId, id)
    if (row.version !== version) conflict()
    if (row.status === 'published') stateConflict()
    if (!complete(row.input)) invalid('请输入标题、测试对象和类别，并在两侧各选择至少一个切片。')
    const slices = await slicesByIds(db, ids(row.input), false, model, dimension)
    validateReferences(row.input, datasetId, slices)
    return slices
  }, true) : new Map<string, SliceRow>()
  const pending = [...prepared.values()].filter(slice => slice.side === 'source' && !slice.indexed)
  const embeddings = await embed(pending.map(slice => slice.text))
  const vectors = new Map(pending.map((slice, index) => [slice.sliceId, embeddings[index]]))

  return transaction(pool, async db => {
    await dataset(db, datasetId, 'write')
    const row = await record(db, datasetId, id, true)
    if (row.version !== version) conflict()
    if (publish === (row.status === 'published')) stateConflict()
    const slices = await slicesByIds(db, ids(row.input), true, model, dimension)
    if (publish) {
      validateReferences(row.input, datasetId, slices)
      if (!complete(row.input)) invalid('案例未满足发布条件。')
      for (const slice of slices.values()) {
        if (slice.side !== 'source') continue
        if (prepared.get(slice.sliceId)?.version !== slice.version) conflict()
        if (slice.indexed) continue
        const vector = vectors.get(slice.sliceId)
        if (!vector) conflict()
        await db.query('UPDATE slices SET embedding=$2::vector,embedding_model=$3,embedding_version=version WHERE id=$1',
          [slice.sliceId, vectorLiteral(vector), model])
      }
    }
    const { rows: [next] } = await db.query<CaseRow>(
      `UPDATE cases SET status=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING ${columns}`,
      [id, publish ? 'published' : 'withdrawn'])
    await snapshot(db, id)
    await touch(db, datasetId)
    return detail(next, slices)
  })
}

export async function listCases(pool: Pool, datasetId: string, filter: Filters, page?: { page: number; pageSize: number },
  documentRoot?: string) {
  return transaction(pool, async db => {
    const owner = await dataset(db, datasetId)
    if (!page && owner.status !== 'active') return { items: [], total: 0 }
    const where = `FROM ${page ? 'cases' : 'eligible_cases'} c
      WHERE dataset_id=$1 AND ($2::text IS NULL OR status=$2)
      AND ($3::timestamptz IS NULL OR updated_at >= $3)
      AND ($4::text IS NULL OR (input->'categories') ? $4)
      AND ($5='' OR strpos(lower(normalize(input->>'testObject', NFKC)),$5)>0)
      AND ($6='' OR strpos(lower(normalize(input->>'interfaceType', NFKC)),$6)>0)
      AND ($7='' OR strpos(lower(normalize(input->>'scenario', NFKC)),$7)>0)
      AND ($8='' OR strpos(lower(normalize(input->>'title', NFKC)),$8)>0 OR EXISTS (
        SELECT FROM case_slices r JOIN slices s ON s.id=r.slice_id
        WHERE r.case_id=c.id AND strpos(lower(normalize(s.text, NFKC)),$8)>0))`
    const params = [datasetId, filter.status ?? null, filter.updatedSince ?? null, filter.category ?? null,
      normalize(filter.testObject ?? ''), normalize(filter.interfaceType ?? ''),
      normalize(filter.scenario ?? ''), normalize(filter.q ?? '')]
    const total = page ? Number((await db.query('SELECT count(*) total ' + where, params)).rows[0].total) : undefined
    const { rows } = await db.query<CaseRow>(`SELECT ${columns} ${where} ORDER BY updated_at DESC,id
      ${page ? 'LIMIT $9 OFFSET $10' : ''}`, page
      ? [...params, page.pageSize, ((BigInt(page.page) - 1n) * BigInt(page.pageSize)).toString()]
      : params)
    const slices = await slicesByIds(db, [...new Set(rows.flatMap(row => ids(row.input)))])
    const items = rows.map(row => detail(row, slices)).filter(row => page || row.valid)
    return { items: documentRoot ? await enrichCaseTables(db, documentRoot, datasetId, items) : items,
      total: total ?? items.length }
  }, true)
}

export async function searchCases(pool: Pool, config: Config, embed: Embed, query: string, limit = 5,
  mode: 'hybrid' | 'keyword' | 'semantic' = 'hybrid') {
  const [vector] = mode === 'keyword' ? [] : await embed([query])
  const { words, identifiers } = tokens(query)
  return transaction(pool, async db => {
    const { rows } = await db.query<{
      caseId: string; datasetId: string; datasetName: string; caseTitle: string; matchedIds: string[]; requirementIds: string[]
    }>(`
      WITH eligible AS (
        SELECT DISTINCT r.slice_id FROM eligible_cases c JOIN case_slices r ON r.case_id=c.id WHERE r.side='source'
      ), query AS (
        SELECT to_tsquery('simple', coalesce(string_agg(quote_literal(term), ' | '), '')) terms
        FROM unnest(tsvector_to_array(to_tsvector('simple',$2))) term
      ), keyword AS (
        SELECT s.id,row_number() OVER (ORDER BY s.identifiers && $3::text[] DESC,ts_rank_cd(s.terms,q.terms) DESC,s.id) rank
        FROM slices s JOIN eligible e ON e.slice_id=s.id CROSS JOIN query q
        WHERE $9 <> 'semantic' AND (s.terms @@ q.terms OR s.identifiers && $3::text[])
        ORDER BY rank LIMIT $4
      ), distances AS MATERIALIZED (
        SELECT s.id,s.embedding <=> $1::vector distance FROM slices s JOIN eligible e ON e.slice_id=s.id
        WHERE $9 <> 'keyword' AND s.embedding_model=$5 AND s.embedding_version=s.version AND vector_dims(s.embedding)=$6
      ), semantic AS (
        SELECT id,row_number() OVER (ORDER BY distance,id) rank FROM distances
        WHERE 1-distance >= $7 ORDER BY rank LIMIT $4
      ), fused AS (
        SELECT coalesce(k.id,v.id) id,
          coalesce(1::numeric/(60+k.rank),0)+coalesce(1::numeric/(60+v.rank),0) score
        FROM keyword k FULL JOIN semantic v USING(id)
      )
      SELECT c.id "caseId",d.id "datasetId",d.name "datasetName",c.input->>'title' "caseTitle",
        array_agg(f.id ORDER BY f.score DESC,f.id) "matchedIds",
        ARRAY(SELECT tr.slice_id FROM case_slices tr WHERE tr.case_id=c.id AND tr.side='test_requirement'
          ORDER BY tr.position) "requirementIds"
      FROM fused f JOIN case_slices r ON r.slice_id=f.id AND r.side='source'
      JOIN eligible_cases c ON c.id=r.case_id JOIN datasets d ON d.id=c.dataset_id
      GROUP BY c.id,c.input,d.id ORDER BY max(f.score) DESC,c.id LIMIT $8
    `, [vector ? vectorLiteral(vector) : null, words.join(' '), identifiers, Math.max(limit, config.SEARCH_CANDIDATES),
      config.EMBEDDING_MODEL, config.EMBEDDING_DIMENSION, config.SEARCH_MIN_COSINE, limit, mode])
    const slices = await slicesByIds(db, [...new Set(rows.flatMap(row => [...row.matchedIds, ...row.requirementIds]))])
    const get = (ids: string[]) => ids.map(id => {
      const slice = slices.get(id)!
      return { ...excerpt(slice), version: slice.version }
    })
    return { results: rows.map(({ matchedIds, requirementIds, ...row }) =>
      ({ ...row, matchedSourceSlices: get(matchedIds), testRequirementSlices: get(requirementIds) })) }
  }, true)
}
