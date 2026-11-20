import { sanitizePossibleWordXmlLine, sanitizePossibleWordXmlText } from "./word-xml-sanitize.js"
interface Segment {
  segment_id: string
  title: string
  text: string
  level: number
  section_path_ids?: string[]
  section_path_titles?: string[]
}

interface TocEntry {
  segment_id: string
  level: number
  title: string
  section_path_ids?: string[]
  section_path_titles?: string[]
}

const STRUCTURED_REQUIREMENT_ID_RE = /^(?:SRS|REQ|SR|FR|NFR|IR)-((?:[A-Za-z]|\d+)(?:\.(?:\d+|[A-Za-z]))*)(?:__\d+)?$/i
function normalizeText(text: string): string {
  return sanitizePossibleWordXmlText(text)
    .split("\n")
    .map((line) => sanitizePossibleWordXmlLine(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
}

function isLikelyBase64BlobLine(line: string): boolean {
  const compact = line.replace(/\s+/g, "")
  if (compact.length < 120) return false
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(compact)) return true
  return /^[A-Za-z0-9+/=]+$/.test(compact)
}

export function sanitizeExtractedDocumentText(text: string): string {
  return text
    .replace(/<!--\s*image\s*-->/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<a\b[^>]*>/gi, "")
    .replace(/<\/a>/gi, "")
    .replace(/\[([^\]]+)]\(#_Toc[^)]+\)/gi, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return false
      if (/data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return false
      if (isLikelyBase64BlobLine(trimmed)) return false
      return true
    })
    .join("\n")
}

function shouldSkipNoiseLine(line: string): boolean {
  const v = line.trim()
  if (!v) return false
  if (/^(?:contents?|\u76ee\u5f55)$/iu.test(v)) return true
  if (/^[-_=.\s]{6,}$/.test(v)) return true
  if (/^(?:page\s*)?\d+\s*\/\s*\d+$/i.test(v)) return true
  if (/_Toc\d+/i.test(v)) return true
  if (/^\d+(?:\.\d+)*\s+.+\s+\d+$/.test(v)) return true
  return false
}

function normalizeHeadingCandidate(raw: string): string {
  return sanitizePossibleWordXmlLine(raw)
    .replace(/<a\b[^>]*>/gi, "")
    .replace(/<\/a>/gi, "")
    .replace(/\[([^\]]+)]\(#_Toc[^)]+\)/gi, "$1")
    .replaceAll("\\.", ".")
    .replaceAll("\\(", "(")
    .replaceAll("\\)", ")")
    .replace(/^[_*~`]+/u, "")
    .replace(/[_*~`]+$/u, "")
    .replace(/\s*\.{3,}\s*\d+\s*$/, "")
    .replace(/[ \t]+/g, " ")
    .trim()
}

function normalizeTitleForDedupe(title: string): string {
  return normalizeHeadingCandidate(title).replace(/\s+/g, " ").trim().toLowerCase()
}

function isLikelyHeadingTitle(title: string): boolean {
  const t = normalizeHeadingCandidate(title)
  if (!t || t.length < 2) return false
  if (t.length > 80) return false
  if (/^\d+(?:\s+\d+){2,}$/.test(t)) return false
  if (/^(?:W|P)\d+(?:\.\d+)?\b/i.test(t)) return false
  if (/^\d+\s*[:]/.test(t)) return false
  if (/\b[0-9A-F]{2,}H\b/i.test(t)) return false
  // Removed a broken legacy noise filter that was corrupted by encoding issues.
  if (/^\d+\s+\S+\s+\d+[A-Za-z]?$/.test(t)) return false
  if (/^\d\s+\d/.test(t)) return false
  const letters = (t.match(/[A-Za-z\u4e00-\u9fa5]/g) || []).length
  return letters > 0
}

function extractTopLevelStructuredNumber(sectionId: string): number | null {
  const match = textOf(sectionId).match(STRUCTURED_REQUIREMENT_ID_RE)
  if (!match) return null
  const [head] = match[1].split(".")
  if (!/^\d+$/.test(head || "")) return null
  return Number.parseInt(head, 10)
}

function currentTopLevelStructuredNumber(
  headingStack: Array<{ section_id: string; title: string; level: number }>,
): number | null {
  for (const entry of headingStack) {
    const num = extractTopLevelStructuredNumber(entry.section_id)
    if (num !== null) return num
  }
  return null
}

function isLikelySingleNumberChapterTitle(
  rawNumber: string,
  title: string,
  currentTopLevelNumber: number | null,
): boolean {
  const t = normalizeHeadingCandidate(title)
  if (!isLikelyHeadingTitle(t)) return false
  const chapterNumber = Number.parseInt(rawNumber, 10)
  if (!Number.isNaN(chapterNumber) && chapterNumber <= 0) return false
  if (!Number.isNaN(chapterNumber) && chapterNumber > 50) return false
  if (
    currentTopLevelNumber !== null &&
    !Number.isNaN(chapterNumber) &&
    currentTopLevelNumber >= 2 &&
    chapterNumber < currentTopLevelNumber
  ) {
    return false
  }
  if (t.length > 40) return false
  if (/^[：:；;，,。.!！？、]/u.test(t)) return false
  if (/[；;。!?！？]/u.test(t)) return false
  if (/^(?:次|秒|分钟|小时|天|月|年|个|项|位|路|帧|字节|字|安|伏|毫秒|A|V|Ah|ms|s|h)(?:[：:；;，,。、]|$)/iu.test(t)) {
    return false
  }
  return true
}

function isLikelyListItem(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (/^\d+[.)]\s+/.test(t)) return true
  if (/^[A-Za-z]\)\s+/.test(t)) return true
  if (/^\(\d+\)\s+/.test(t)) return true
  return false
}

function levelFromId(segmentID: string): number {
  const m = segmentID.match(STRUCTURED_REQUIREMENT_ID_RE)
  if (!m) return 1
  return m[1].split(".").length
}

function normalizeStructuredSegmentId(prefix: string, rawNumber: string): string {
  const normalizedPrefix = (prefix || "SRS").toUpperCase()
  const normalizedNumber = textOf(rawNumber).toUpperCase()
  if (!normalizedNumber) return `${normalizedPrefix}-${pad3(1)}`
  if (/^\d+$/.test(normalizedNumber)) {
    return `${normalizedPrefix}-${pad3(Number(normalizedNumber))}`
  }
  return `${normalizedPrefix}-${normalizedNumber}`
}

function parseStructuredHeadingFromTitle(
  rawTitle: string,
  prefix = "SRS",
): { segment_id: string; title: string } | null {
  const normalized = normalizeHeadingCandidate(rawTitle)
  const annexMatch = normalized.match(
    /^(?:\d+(?:\.\d+)*[.\uFF0E\u3002]?\s*)?(?:\u9644\u4ef6|\u9644\u5f55)\s*([A-Za-z])(?:\s*[\uFF08(][^\uFF09)]*[\uFF09)])?\s*(.+)$/u,
  )
  if (annexMatch) {
    const [, rawNumber, rawHeadingTitle] = annexMatch
    const headingTitle = normalizeHeadingCandidate(rawHeadingTitle)
    if (!headingTitle || !isLikelyHeadingTitle(headingTitle)) return null
    return {
      segment_id: normalizeStructuredSegmentId(prefix, rawNumber),
      title: headingTitle,
    }
  }

  // Some Word/WPS documents store the final punctuation of a visible heading
  // number as literal paragraph text instead of numbering metadata, for example
  // "5.2.4.3. Title". Treat that punctuation as part of the label separator so
  // the heading keeps its canonical SRS id instead of falling back to SEG-NNN.
  const hierarchical = normalized.match(/^(\d+(?:\.\d+)+|[A-Za-z](?:\.\d+)+)[.\uFF0E\u3002]?\s*(.+)$/u)
  const delimitedTopLevel = normalized.match(/^(\d+)(?:[.\uFF0E\u3002]\s*|\s+)(.+)$/u)
  const compactCandidate = normalized.match(/^(\d{1,2})([A-Za-z\u4e00-\u9fff（(].*)$/u)
  const compactTopLevel = compactCandidate && Number(compactCandidate[1]) >= 1 && Number(compactCandidate[1]) <= 20
    ? compactCandidate
    : null
  const match = hierarchical || delimitedTopLevel || compactTopLevel
  if (!match) return null
  const [, rawNumber, rawHeadingTitle] = match
  const headingTitle = normalizeHeadingCandidate(rawHeadingTitle)
  if (!headingTitle || !isLikelyHeadingTitle(headingTitle)) return null
  return {
    segment_id: normalizeStructuredSegmentId(prefix, rawNumber),
    title: headingTitle,
  }
}

function makeFallbackSegmentId(seq: number): string {
  return `SEG-${pad3(seq)}`
}

interface ParseSegmentsOptions {
  markdownHeadersOnly?: boolean
  skipUntilFirstHeading?: boolean
  preservePreamble?: boolean
}

export function parseSegments(content: string, options: ParseSegmentsOptions = {}): Segment[] {
  const lines = content.split("\n")
  const segments: Segment[] = []
  const markdownHeadersOnly = options.markdownHeadersOnly === true
  const skipUntilFirstHeading = options.skipUntilFirstHeading === true
  const preservePreamble = options.preservePreamble === true

  let current: Segment | null = null
  let seq = 0
  let inTocBlock = false
  const headingStack: Array<{ section_id: string; title: string; level: number }> = []
  let sawMarkdownHeading = false

  const newSegment = (
    title: string,
    idHint?: string,
    sectionPathIds: string[] = [],
    sectionPathTitles: string[] = [],
    levelHint?: number,
  ) => {
    seq += 1
    const segmentID = idHint || makeFallbackSegmentId(seq)
    current = {
      segment_id: segmentID,
      title: normalizeHeadingCandidate(title) || `segment-${seq}`,
      text: "",
      level: levelHint ?? levelFromId(segmentID),
      section_path_ids: sectionPathIds,
      section_path_titles: sectionPathTitles,
    }
  }

  const pushStructuredHeading = (segmentID: string, title: string, levelHint?: number) => {
    const normalizedTitle = normalizeHeadingCandidate(title) || title.trim()
    const level = levelHint ?? levelFromId(segmentID)
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop()
    }
    headingStack.push({
      section_id: segmentID,
      title: normalizedTitle,
      level,
    })
    return {
      ids: headingStack.map((entry) => entry.section_id),
      titles: headingStack.map((entry) => entry.title),
    }
  }

  const flush = () => {
    if (!current) return
    current.text = normalizeText(current.text)
    if (current.title || current.text) {
      segments.push(current)
    }
  }

  for (const rawLine of lines) {
    const sanitizedLine = sanitizePossibleWordXmlLine(rawLine)
    const line = sanitizedLine.trim()
    const headingLine = line
      .replaceAll("\\.", ".")
      .replaceAll("\\(", "(")
      .replaceAll("\\)", ")")
    const normalizedMarker = line.replace(/^[_*~\s]+|[_*~\s]+$/g, "")
    if (/^(?:contents?|\u76ee\u5f55)$/iu.test(normalizedMarker)) {
      inTocBlock = true
      continue
    }
    if (shouldSkipNoiseLine(line)) continue

    const mdHeadingMarker = headingLine.match(/^(#{1,6})\s+/)?.[1] || ""
    const mdHeadingLevel = mdHeadingMarker.length || undefined
    const mdHeader = headingLine.match(/^#{1,6}\s+(?:(SRS|REQ|SR|FR|NFR|IR)-((?:\d+|[A-Za-z])(?:\.(?:\d+|[A-Za-z]))*)[:\s]+)?(.+)/i)

    const numHeader = !markdownHeadersOnly && !mdHeader
      ? headingLine.match(/^(\d+(?:\.\d+)+)[.\uFF0E\u3002]?\s+(.+?)(?:\s*\.{3,}\s*\d+)?$/u)
      : null
    const chapterHeader = !markdownHeadersOnly && !mdHeader && !numHeader
      ? headingLine.match(/^(\d+)\s+(.+?)(?:\s*\.{3,}\s*\d+)?$/)
      : null
    const acceptedMdHeader = !!(mdHeader && isLikelyHeadingTitle(mdHeader[3]))
    const acceptedNumHeader = !!(
      numHeader &&
      !isLikelyListItem(line) &&
      isLikelyHeadingTitle(numHeader[2])
    )
    const acceptedChapterHeader = !!(
      chapterHeader &&
      !isLikelyListItem(line) &&
      isLikelySingleNumberChapterTitle(chapterHeader[1], chapterHeader[2], currentTopLevelStructuredNumber(headingStack))
    )

    if (!sawMarkdownHeading && (acceptedMdHeader || acceptedNumHeader || acceptedChapterHeader)) {
      sawMarkdownHeading = true
    }
    if (skipUntilFirstHeading && !sawMarkdownHeading) continue

    const isTocLine = !!(numHeader && /\.{3,}\s*\d+\s*$/.test(line))
    const isTocChapterLine = !!(chapterHeader && /\.{3,}\s*\d+\s*$/.test(line))

    if (inTocBlock && !mdHeader && !numHeader && !chapterHeader) continue
    if (inTocBlock && (numHeader || chapterHeader) && !isTocLine && !isTocChapterLine) {
      inTocBlock = false
    }
    if (mdHeader) inTocBlock = false

    if (acceptedMdHeader && mdHeader) {
      flush()
      const prefix = (mdHeader[1] || "SRS").toUpperCase()
      const num = mdHeader[2]
      const parsedFromTitle = !num ? parseStructuredHeadingFromTitle(mdHeader[3], prefix) : null
      const id = num
        ? normalizeStructuredSegmentId(prefix, num)
        : parsedFromTitle?.segment_id
      const headingTitle = parsedFromTitle?.title || mdHeader[3]
      if (id) {
        const effectiveHeadingLevel = /^SRS-[A-Z]$/i.test(id) ? 1 : mdHeadingLevel
        const path = pushStructuredHeading(id, headingTitle, effectiveHeadingLevel)
        newSegment(headingTitle, id, path.ids, path.titles, effectiveHeadingLevel)
      } else {
        const fallbackId = makeFallbackSegmentId(seq + 1)
        const path = pushStructuredHeading(fallbackId, headingTitle, mdHeadingLevel)
        newSegment(headingTitle, fallbackId, path.ids, path.titles, mdHeadingLevel)
      }
      continue
    }

    if (
      acceptedNumHeader &&
      numHeader &&
      !isTocLine &&
      !isLikelyListItem(line)
    ) {
      flush()
      const id = normalizeStructuredSegmentId("SRS", numHeader[1])
      const path = pushStructuredHeading(id, numHeader[2])
      newSegment(numHeader[2], id, path.ids, path.titles)
      continue
    }

    if (
      acceptedChapterHeader &&
      chapterHeader &&
      !isTocChapterLine &&
      !isLikelyListItem(line)
    ) {
      flush()
      const id = normalizeStructuredSegmentId("SRS", chapterHeader[1])
      const path = pushStructuredHeading(id, chapterHeader[2])
      newSegment(chapterHeader[2], id, path.ids, path.titles)
      continue
    }

    if (!current && line) {
      if (preservePreamble) {
        newSegment("文档前置内容", "SRS-PREAMBLE", ["SRS-PREAMBLE"], ["文档前置内容"], 1)
      } else {
        newSegment("preamble")
      }
    }
    if (current as Segment | null) {
      current!.text += (current!.text ? "\n" : "") + sanitizedLine
    }
  }

  flush()
  const filtered = segments.filter((s) => s.title.length > 0 || s.text.length > 0)
  const seenNonRequirementTitles = new Set<string>()
  const deduped: Segment[] = []
  for (const segment of filtered) {
    const normalizedTitle = normalizeTitleForDedupe(segment.title)
    if (
      normalizedTitle
      && isLikelyNonRequirementByTitle(segment.title)
      && !/^(?:SRS|REQ|SR|FR|NFR|IR)-(?:(?:\d+|[A-Za-z])\.)+(?:\d+|[A-Za-z])$/i.test(segment.segment_id)
    ) {
      if (seenNonRequirementTitles.has(normalizedTitle)) {
        continue
      }
      seenNonRequirementTitles.add(normalizedTitle)
    }
    deduped.push(segment)
  }
  return deduped
}

export function buildToc(segments: Segment[]): TocEntry[] {
  return segments.map((s) => ({
    segment_id: s.segment_id,
    level: s.level,
    title: s.title,
    section_path_ids: Array.isArray(s.section_path_ids) ? [...s.section_path_ids] : [],
    section_path_titles: Array.isArray(s.section_path_titles) ? [...s.section_path_titles] : [],
  }))
}

function isLikelyNonRequirementByTitle(title: string): boolean {
  const normalized = title.replace(/\s+/g, " ").trim()
  if (!normalized) return false
  if (/^preamble$/iu.test(normalized)) return true
  if (/^文档前置内容$/u.test(normalized)) return true
  if (/需求规格说明/u.test(normalized)) return true
  if (/^(附件|附录)\s*[A-Za-z0-9一二三四五六七八九十]/u.test(normalized)) return true
  if (/^(表格?|图)\s*[A-Za-z0-9一二三四五六七八九十]/u.test(normalized)) return true
  return /(封面|修订|版本|目录|文档概述|引言|标识|引用文档|验收|可跟踪|人员需求|培训需求|其他需求|附录|前言)/u.test(normalized)
}

function pad3(n: number): string {
  return String(n).padStart(3, "0")
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}
