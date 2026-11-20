import { randomUUID } from 'node:crypto'
import { open, type ZipFile } from 'yauzl'
import { ApiError } from './contract.js'
import { extractDocxText } from './parser/docx-heading-numbering.js'
import { buildDocumentStructureArtifact } from './parser/document-structure-artifact.js'
import { buildToc, parseSegments, sanitizeExtractedDocumentText } from './parser/segments.js'
import { containsContext, parseTable, sharedTableContext } from './tables.js'

export interface SliceDraft {
  id: string
  sectionId: string
  sectionPath: string[]
  sourceRef: string
  kind: 'paragraph' | 'clause' | 'table' | 'table_row'
  text: string
  parentId?: string
  rowOrder?: number
}

async function validateArchive(path: string, limit: number) {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, file) =>
      error ? reject(error) : resolve(file))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let bytes = 0
      const names = new Set<string>()
      const check = () => {
        if (bytes > limit) throw new ApiError(413, 'DOCX_TOO_LARGE', 'DOCX 解压大小超限。')
      }
      zip.on('error', reject)
      zip.on('end', () => {
        if (names.has('word/document.xml') && names.has('[Content_Types].xml')) resolve()
        else reject(new Error('Incomplete DOCX'))
      })
      zip.on('entry', entry => {
        void (async () => {
          if (names.has(entry.fileName) || names.size >= 20000) throw new Error('Invalid ZIP directory')
          names.add(entry.fileName)
          if (bytes + entry.uncompressedSize > limit) throw new ApiError(413, 'DOCX_TOO_LARGE', 'DOCX 解压大小超限。')
          if (!entry.fileName.endsWith('/')) {
            const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
              zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream))
            })
            for await (const chunk of stream) { bytes += chunk.length; check() }
          }
          zip.readEntry()
        })().catch(reject)
      })
      zip.readEntry()
    })
  } finally { zip.close() }
}

export async function parseDocx(path: string, limit: number) {
  try {
    await validateArchive(path, limit)
    const markdown = sanitizeExtractedDocumentText(await extractDocxText(path))
    const segments = parseSegments(markdown, { markdownHeadersOnly: true, preservePreamble: true })
    if (segments[0]?.segment_id !== 'SRS-PREAMBLE') {
      segments.unshift({ segment_id: 'SRS-PREAMBLE', title: '文档前置内容', level: 1, text: '' })
    }
    const structure = buildDocumentStructureArtifact(path, { format: 'docx', segments, toc: buildToc(segments) })
    structure.file_path = 'original.docx'
    const slices: SliceDraft[] = []
    for (const section of structure.sections) {
      let clause: SliceDraft | undefined
      for (const [position, block] of section.body_blocks.entries()) {
        const base = { sectionId: section.section_id, sectionPath: section.section_path_titles }
        if ('tableIndex' in block) {
          clause = undefined
          const table = section.tables[block.tableIndex]
          const parentId = randomUUID()
          const headerIndex = table.source_rows.findIndex(cells => cells.some(cell => cell.text))
          const headers = table.source_rows[headerIndex] ?? []
          const shared = sharedTableContext(parseTable(table.table_html))
          const rows = table.source_rows.flatMap((cells, index): SliceDraft[] => {
            if (!cells.some(cell => cell.text)) return []
            const body = cells.map(cell => {
              if (index === headerIndex) return cell.text
              const header = headers.find(header => header.column <= cell.column && cell.column < header.column + header.span)
              return (header?.text || '列 ' + (cell.column + 1)) + '：' + cell.text
            }).join(' | ')
            const text = [body, ...(shared[index] ?? []).filter(value => !containsContext(body, value))
              .map(value => '共享条件：' + value)].join('\n')
            return [{ ...base, id: randomUUID(), parentId, rowOrder: index + 1,
              kind: 'table_row', text, sourceRef: table.table_id + ' / 第 ' + (index + 1) + ' 行' }]
          })
          if (rows.length) slices.push({ ...base, id: parentId, kind: 'table', sourceRef: table.table_id,
            text: rows.map(row => row.text).join('\n') }, ...rows)
        } else {
          const text = block.text.trim()
          if (!text || /^(?:目录|contents?)$|\.{3,}\s*\d+$/iu.test(text)) continue
          const isClause = /^(?:(?:SRS|REQ|SR|FR|NFR|IR)-[\w.]+|\d+(?:\.\d+)+)[\s:：、]/iu.test(text)
          if (clause && !isClause) { clause.text += '\n' + text; continue }
          const slice: SliceDraft = { ...base, id: randomUUID(), sourceRef: section.source_ref + ' / 正文块 ' + (position + 1),
            kind: isClause ? 'clause' : 'paragraph', text }
          slices.push(slice)
          clause = isClause ? slice : undefined
        }
      }
    }
    if (!slices.length) throw new ApiError(400, 'DOCX_EMPTY', 'DOCX 中没有可用文本。')
    return { structure, slices, warnings: (structure.warnings ?? []).map(warning => warning.message) }
  } catch (error) {
    if (error instanceof ApiError) throw error
    const failure = new ApiError(400, 'DOCX_PARSE_FAILED', 'DOCX 无法解析，请检查文件后重新导入。')
    failure.cause = error
    throw failure
  }
}
