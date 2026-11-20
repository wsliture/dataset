import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseDocx } from '../src/docx.js'
import { resolveHeadings } from '../src/parser/docx-heading-resolver.js'
import { readZip, writeZip } from '../src/parser/docx-zip.js'
import { docx } from './fixture.js'
import { parseTable, sharedTableContext } from '../src/tables.js'

test('table layout preserves spans and nested tables and maps shared text by top-level row', () => {
  const rows = parseTable('<table><tr><td colspan="2" rowspan="3" onclick="bad()">适用条件&lt;script&gt;</td>' +
    '<td>首行<table><tr><td>内表</td></tr></table></td></tr><tr></tr><tr><td>第三行<script>bad()</script></td></tr></table>')
  assert.equal(rows.length, 3)
  assert.equal(rows[0].cells[0].rowSpan, 3)
  assert.equal(rows[0].cells[0].colSpan, 2)
  assert.deepEqual(rows[0].cells[0].content, ['适用条件<script>'])
  assert.deepEqual(rows[2].cells[0].content, ['第三行'])
  assert.deepEqual(sharedTableContext(rows), [[], ['适用条件<script>'], ['适用条件<script>']])
})

test('Phase 2 numbering honors Word start overrides and suppresses body lists', () => {
  const styles = '<w:styles><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
    '<w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>'
  const numbering = '<w:numbering><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/>' +
    '<w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="7"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/>' +
    '</w:lvlOverride></w:num></w:numbering>'
  const heading = (title: string) => '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/>' +
    '<w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>' + title + '</w:t></w:r></w:p>'
  const body = '<w:document><w:body>' + heading('接口说明') +
    '<w:p><w:r><w:t>1) 先执行复位操作。</w:t></w:r></w:p>' + heading('恢复条件') + '</w:body></w:document>'
  assert.deepEqual(resolveHeadings(body, numbering, styles).map(heading => [heading.label, heading.title]),
    [['4', '接口说明'], ['5', '恢复条件']])
})

test('actual DOCX order, row provenance, empty documents and expansion limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dataset-parser-'))
  try {
    const path = join(root, 'document.docx')
    const content = docx(['前置范围', '末尾验收条件'])
    await writeFile(path, content)
    const output = await parseDocx(path, 100000)
    assert.deepEqual(output.slices.map(slice => slice.kind), ['paragraph', 'table', 'table_row', 'table_row', 'paragraph'])
    assert.equal(output.slices[0].text, '前置范围')
    assert.equal(output.slices.at(-1)?.text, '末尾验收条件')
    assert.equal(output.slices[3].rowOrder, 2)
    assert.match(output.slices[3].text, /接口：CAN-01/)
    assert.match(output.slices[3].sourceRef, /第 2 行/)
    await assert.rejects(parseDocx(path, 100), { status: 413, code: 'DOCX_TOO_LARGE' })
    const merged = '<w:tbl><w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>' +
      '<w:p><w:r><w:t>仅复位状态</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>CR</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>' +
      '<w:tc><w:p><w:r><w:t>ACR</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    await writeFile(path, writeZip([...readZip(content)].map(([path, data]) => ({
      path, data: path === 'word/document.xml'
        ? Buffer.from(data.toString().replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, merged)) : data,
    }))))
    const mergedRows = (await parseDocx(path, 100000)).slices.filter(slice => slice.kind === 'table_row')
    assert.equal(mergedRows[1].rowOrder, 2)
    assert.match(mergedRows[1].text, /共享条件：仅复位状态/)
    const entries = [...readZip(content)].map(([path, data]) => ({ path, data: path === 'word/document.xml'
      ? Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>')
      : data }))
    await writeFile(path, writeZip(entries))
    await assert.rejects(parseDocx(path, 100000), { status: 400, code: 'DOCX_EMPTY' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
