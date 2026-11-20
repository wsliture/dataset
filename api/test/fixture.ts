import { writeZip } from '../src/parser/docx-zip.js'

export function docx(paragraphs: string[]) {
  const paragraph = (text: string) => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'
  const row = (cells: string[]) => '<w:tr>' + cells.map(cell => '<w:tc>' + paragraph(cell) + '</w:tc>').join('') + '</w:tr>'
  const body = paragraph(paragraphs[0]) + '<w:tbl>' + row(['接口', '阈值']) + row(['CAN-01', '100 ms']) +
    '</w:tbl>' + paragraphs.slice(1).map(paragraph).join('')
  return writeZip([
    { path: '[Content_Types].xml', data: Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { path: '_rels/.rels', data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { path: 'word/document.xml', data: Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>') },
  ])
}

export const sourceTexts = ['CAN-01 控制器在复位模式进入初始化状态。', 'TEMP-02 控制器在温度超过八十摄氏度时报警。']
export const testTexts = ['将 CAN 控制器切换至复位模式。', '输入温度八十一摄氏度，检查报警。', '温度回落后检查状态恢复。']
