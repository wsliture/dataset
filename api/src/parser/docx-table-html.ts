import { decodeXmlEntities, extractTablesFromXml, type ParsedCell, type ParsedTable } from "./docx-heading-resolver.js"

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function orderedContent(cell: ParsedCell): NonNullable<ParsedCell["content"]> {
  return cell.content ?? [
    ...cell.paragraphs.map((text) => ({ kind: "paragraph" as const, text })),
    ...(cell.subTables || []).map((table) => ({ kind: "table" as const, table })),
  ]
}

/** Read cells without flattening nested-table text twice or moving trailing paragraphs. */
export function parsedCellText(cell: ParsedCell): string {
  return orderedContent(cell).map((part) => part.kind === "paragraph"
    ? part.text
    : part.table.rows.map((row) => row.cells.map(parsedCellText).join("\t")).join("\n"))
    .filter(Boolean).join("\n")
}

function cellContentHtml(cell: ParsedCell): string {
  return orderedContent(cell).map((part) => part.kind === "paragraph"
    ? escapeHtml(part.text).replace(/\n/g, "<br>")
    : parsedTableToHtml(part.table))
    .filter(Boolean).join("<br>")
}

/** Render the same ordered/merged cell model used by requirement extraction. */
export function parsedTableToHtml(table: ParsedTable): string {
  const lines = ["<table>"]
  for (const [rowIndex, row] of table.rows.entries()) {
    lines.push("  <tr>")
    for (const cell of row.cells) {
      if (cell.mergeContinuation) continue
      const rowSpan = cell.rowSpan || 1
      const colSpan = cell.colSpan || 1
      const attrs = [
        rowSpan > 1 ? `rowspan="${rowSpan}"` : "",
        colSpan > 1 ? `colspan="${colSpan}"` : "",
      ].filter(Boolean)
      const contents = [cellContentHtml(cell)]
      // Word normally keeps continuation cells empty. If a document contains
      // text there, retain it in the merged cell rather than silently drop it.
      for (let offset = 1; offset < rowSpan; offset++) {
        const continuation = table.rows[rowIndex + offset]?.cells.find((item) =>
          item.mergeContinuation && item.gridColumn === cell.gridColumn)
        if (continuation) contents.push(cellContentHtml(continuation))
      }
      lines.push(`    <td${attrs.length ? ` ${attrs.join(" ")}` : ""}>${contents.filter(Boolean).join("<br>")}</td>`)
    }
    lines.push("  </tr>")
  }
  lines.push("</table>")
  return lines.join("\n")
}

export function docxTableXmlToHtml(tableXml: string): string {
  const table = extractTablesFromXml(tableXml)[0]
  return table ? parsedTableToHtml(table) : "<table>\n</table>"
}

export function htmlTableText(html: string): string {
  return decodeXmlEntities(html
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<\/?(?:table|tr|td|th)\b[^>]*>/gi, " "))
    .replace(/\s+/g, " ")
    .trim()
}
