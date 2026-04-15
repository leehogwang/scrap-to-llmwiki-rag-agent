import fs from 'fs'
import path from 'path'
import OpenAI from 'openai'
import pdf from 'pdf-parse/lib/pdf-parse'
import { load } from 'cheerio'
import {
  listScraps,
  listWikiDrafts
} from '@/lib/server/db'
import { getOptionalEnv, getRequiredEnv } from '@/lib/server/env'
import { getCodexAuth } from '@/lib/server/codex-auth'
import { runCodexJson } from '@/lib/server/codex-client'
import type {
  GraphifyCluster,
  GraphifyEdge,
  GraphifyEdgeRelation,
  GraphifyGodNode,
  GraphifyNode,
  GraphifyNodeDetail,
  GraphifyPayload,
  GraphifyProvenance,
  GraphifySupportSource,
  GraphifySurprisingConnection,
  Scrap,
  WikiDraft
} from '@/lib/types'

const dataDir = path.join(process.cwd(), 'data')
const cachePath = path.join(dataDir, 'graphify-cache.json')
const webCachePath = path.join(dataDir, 'graphify-web-cache.json')
const paperSearchCachePath = path.join(dataDir, 'graphify-paper-search-cache.json')
const paperContentCachePath = path.join(dataDir, 'graphify-paper-content-cache.json')
const paperQueryCachePath = path.join(dataDir, 'graphify-paper-query-cache.json')
const paperRankCachePath = path.join(dataDir, 'graphify-paper-rank-cache.json')
const defaultModel = getOptionalEnv('OPENAI_MODEL', 'gpt-4.1-mini')
const useCodexAuth = getOptionalEnv('USE_CODEX_AUTH', 'false') === 'true'
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

function buildClient(): OpenAI {
  if (useCodexAuth) {
    const auth = getCodexAuth()
    if (auth) {
      return new OpenAI({
        apiKey: auth.accessToken,
        baseURL: CODEX_BASE_URL,
        defaultHeaders: { 'ChatGPT-Account-Id': auth.accountId }
      })
    }
  }
  // Fallback to standard OpenAI API key
  return new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY') })
}

const client = buildClient()

const clusterColors = ['#56728f', '#a57758', '#5f8376', '#8a6576', '#6f67a0', '#7f8758', '#4f7f86', '#9a654f']

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9가-힣\s-]/g, ' ')
}

const tokenStopwords = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'your', 'have', 'will', 'what', 'when', 'where',
  'which', 'while', 'using', 'used', 'than', 'then', 'they', 'about', 'over', 'under', 'also', 'just', 'more',
  'most', 'very', 'agent', 'agents', 'model', 'models', 'ai', 'llm', 'llms', 'rag', 'code', 'wiki', 'draft',
  '있는', '하는', '하면', '에서', '으로', '이다', '했다', '하는지', '대한', '관련', '정리', '요약', '자료', '문서',
  '스크랩', '위키', '생성', '구조', '설명', '기능', '개념', '초안', '질문'
])

function extractTokens(text: string) {
  const matches = normalizeText(text).match(/[a-z][a-z0-9-]{2,}|[가-힣]{2,}/g) ?? []
  return Array.from(new Set(matches.filter((token) => !tokenStopwords.has(token))))
}

function overlapScore(left: string[], right: string[]) {
  if (!left.length || !right.length) return 0
  const rightSet = new Set(right)
  return new Set(left.filter((token) => rightSet.has(token))).size
}

function jaccard(left: string[], right: string[]) {
  if (!left.length || !right.length) return 0
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  let intersection = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1
  }
  const union = new Set([...leftSet, ...rightSet]).size
  return union === 0 ? 0 : intersection / union
}

function snippet(value: string, length = 240) {
  return value.replace(/\s+/g, ' ').trim().slice(0, length)
}

function readCache() {
  if (!fs.existsSync(cachePath)) return null
  return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as GraphifyPayload
}

function writeCache(payload: GraphifyPayload) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf8')
}

type WebCacheEntry = {
  notes: string[]
  fetchedAt: string
}

type PaperSearchCacheEntry = {
  candidates: PaperCandidate[]
  fetchedAt: string
}

type PaperContentCacheEntry = {
  result: PaperExtractedContent
  fetchedAt: string
}

type PaperCandidate = {
  id: string
  title: string
  canonicalUrl: string
  htmlUrl?: string
  pdfUrl?: string
  abstract?: string
}

type PaperExtractedContent = {
  title: string
  canonicalUrl: string
  extractionMode: GraphifySupportSource['extractionMode']
  paragraphs: string[]
}

type PaperQueryCacheEntry = {
  queries: string[]
  fetchedAt: string
}

type PaperRankCacheEntry = {
  rankedIds: string[]
  fetchedAt: string
}

function readJsonCache<T>(filePath: string) {
  if (!fs.existsSync(filePath)) return {} as Record<string, T>
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, T>
}

function writeJsonCache<T>(filePath: string, value: Record<string, T>) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function hasHangul(value: string) {
  return /[가-힣]/.test(value)
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ClipWiki/1.0 (Graphify paper enrichment)' }
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return await response.json() as T
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ClipWiki/1.0 (Graphify paper enrichment)' }
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return await response.text()
}

async function fetchArrayBuffer(url: string) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ClipWiki/1.0 (Graphify paper enrichment)' }
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return await response.arrayBuffer()
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function buildWikiPaperQuery(record: {
  title: string
  topic: string
  summary: string
  keyConcepts: string[]
}) {
  const terms = [
    record.title,
    record.topic,
    ...record.keyConcepts.slice(0, 4)
  ]
    .map((term) => normalizeWhitespace(term))
    .filter(Boolean)
  return Array.from(new Set(terms)).join(' ')
}

function extractEnglishTokens(text: string) {
  return Array.from(new Set((normalizeWhitespace(text).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])))
}

function buildArxivPaperQuery(record: {
  title: string
  topic: string
  summary: string
  keyConcepts: string[]
}) {
  const terms = Array.from(new Set([
    ...record.keyConcepts.flatMap((term) => extractEnglishTokens(term)),
    ...extractEnglishTokens(record.title),
    ...extractEnglishTokens(record.topic),
    ...extractEnglishTokens(record.summary)
  ])).slice(0, 6)
  return terms.join(' ')
}

function paperQueryCacheKey(record: {
  title: string
  topic: string
  summary: string
  keyConcepts: string[]
}) {
  return `v1:${normalizeText(`${record.title}\n${record.topic}\n${record.summary}\n${record.keyConcepts.join(' ')}`)}`
}

async function generatePaperSearchQueries(record: {
  title: string
  topic: string
  summary: string
  keyConcepts: string[]
}) {
  const cache = readJsonCache<PaperQueryCacheEntry>(paperQueryCachePath)
  const cacheKey = paperQueryCacheKey(record)
  const cached = cache[cacheKey]
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 24 * 60 * 60 * 1000) {
    return cached.queries
  }

  const fallback = Array.from(new Set([
    buildArxivPaperQuery(record),
    extractEnglishTokens(record.keyConcepts.join(' ')).slice(0, 4).join(' '),
    extractEnglishTokens(`${record.title} ${record.topic}`).slice(0, 4).join(' ')
  ].map((query) => normalizeWhitespace(query)).filter(Boolean))).slice(0, 3)

  const systemPrompt = [
    'Generate concise English arXiv search queries for a Korean wiki topic.',
    'Expand abbreviations when useful, keep only the 2 to 4 most important technical concepts, and avoid long sentences.',
    'Return 1 to 3 query strings that are likely to retrieve relevant research papers.',
    'Queries must be in English and optimized for paper search, not for general web search.',
    'Return JSON only: {"queries":[string]}'
  ].join(' ')

  try {
    let raw: string | undefined
    if (useCodexAuth) {
      raw = JSON.stringify(await runCodexJson<Record<string, unknown>>({
        instructions: systemPrompt,
        input: JSON.stringify({
          title: record.title,
          topic: record.topic,
          summary: record.summary,
          keyConcepts: record.keyConcepts.slice(0, 8)
        })
      }))
    } else {
      const response = await client.chat.completions.create({
        model: defaultModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: JSON.stringify({
              title: record.title,
              topic: record.topic,
              summary: record.summary,
              keyConcepts: record.keyConcepts.slice(0, 8)
            })
          }
        ]
      })
      raw = response.choices[0]?.message?.content ?? undefined
    }
    const parsed = raw ? JSON.parse(raw) as { queries?: string[] } : {}
    const queries = Array.from(new Set((parsed.queries ?? [])
      .map((query) => normalizeWhitespace(query))
      .filter((query) => query && !hasHangul(query)))).slice(0, 3)
    const nextQueries = queries.length > 0 ? queries : fallback
    cache[cacheKey] = {
      queries: nextQueries,
      fetchedAt: new Date().toISOString()
    }
    writeJsonCache(paperQueryCachePath, cache)
    return nextQueries
  } catch {
    cache[cacheKey] = {
      queries: fallback,
      fetchedAt: new Date().toISOString()
    }
    writeJsonCache(paperQueryCachePath, cache)
    return fallback
  }
}

function hydrateAbstract(index?: Record<string, number[]>) {
  if (!index) return ''
  const terms = Object.entries(index)
    .flatMap(([term, positions]) => positions.map((position) => ({ term, position })))
    .sort((left, right) => left.position - right.position)
    .map((entry) => entry.term)
  return normalizeWhitespace(terms.join(' '))
}

function ensureArxivHtml(url: string) {
  const match = url.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#]+)/i)
  if (!match) return undefined
  const rawId = match[1].replace(/\.pdf$/i, '')
  return `https://arxiv.org/html/${rawId}`
}

function ensureArxivAbs(url: string) {
  const match = url.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#]+)/i)
  if (!match) return undefined
  const rawId = match[1].replace(/\.pdf$/i, '')
  return `https://arxiv.org/abs/${rawId}`
}

async function searchPaperCandidates(query: string) {
  const normalizedQuery = normalizeWhitespace(query)
  if (!normalizedQuery) return []

  const cache = readJsonCache<PaperSearchCacheEntry>(paperSearchCachePath)
  const cacheKey = `v2:openalex:${normalizeText(normalizedQuery)}`
  const cached = cache[cacheKey]
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 24 * 60 * 60 * 1000) {
    return cached.candidates
  }

  try {
    const data = await fetchJson<{
      results?: Array<{
        id?: string
        display_name?: string
        abstract_inverted_index?: Record<string, number[]>
        primary_location?: { landing_page_url?: string | null; pdf_url?: string | null }
        best_oa_location?: { landing_page_url?: string | null; pdf_url?: string | null }
        ids?: { doi?: string | null; pmcid?: string | null; pmid?: string | null; arxiv?: string | null }
      }>
    }>(`https://api.openalex.org/works?search=${encodeURIComponent(normalizedQuery)}&per-page=6&mailto=clipwiki@example.com`)

    const candidates = (data.results ?? [])
      .map<PaperCandidate | null>((result, index) => {
        const title = normalizeWhitespace(result.display_name ?? '')
        if (!title) return null
        const arxivUrl = result.ids?.arxiv ?? undefined
        const htmlUrl = arxivUrl ? ensureArxivHtml(arxivUrl) : (result.best_oa_location?.landing_page_url ?? result.primary_location?.landing_page_url ?? undefined) || undefined
        const canonicalUrl = arxivUrl ? (ensureArxivAbs(arxivUrl) ?? arxivUrl) : (result.best_oa_location?.landing_page_url ?? result.primary_location?.landing_page_url ?? result.id ?? `openalex:${index}`)
        const pdfUrl = result.best_oa_location?.pdf_url ?? result.primary_location?.pdf_url ?? undefined
        return {
          id: result.id ?? canonicalUrl,
          title,
          canonicalUrl,
          htmlUrl,
          pdfUrl,
          abstract: hydrateAbstract(result.abstract_inverted_index)
        } satisfies PaperCandidate
      })
      .filter((candidate): candidate is PaperCandidate => candidate !== null)
      .filter((candidate) => Boolean(candidate.htmlUrl || candidate.pdfUrl || candidate.abstract))
      .slice(0, 3)

    cache[cacheKey] = {
      candidates,
      fetchedAt: new Date().toISOString()
    }
    writeJsonCache(paperSearchCachePath, cache)
    return candidates
  } catch {
    return []
  }
}

async function searchArxivCandidates(query: string) {
  const normalizedQuery = normalizeWhitespace(query)
  if (!normalizedQuery) return []

  const cache = readJsonCache<PaperSearchCacheEntry>(paperSearchCachePath)
  const cacheKey = `v2:arxiv:${normalizeText(normalizedQuery)}`
  const cached = cache[cacheKey]
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 24 * 60 * 60 * 1000) {
    return cached.candidates
  }

  try {
    const xml = await fetchText(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(normalizedQuery)}&start=0&max_results=5&sortBy=relevance&sortOrder=descending`
    )
    const $ = load(xml, { xmlMode: true })
    const candidates = $('entry')
      .toArray()
      .map((entry): PaperCandidate | null => {
        const element = $(entry)
        const title = normalizeWhitespace(element.find('title').first().text())
        const idText = normalizeWhitespace(element.find('id').first().text())
        if (!title || !idText) return null
        const abstract = normalizeWhitespace(element.find('summary').first().text())
        const pdfUrl =
          element.find('link[title="pdf"]').attr('href')
          || element.find('link[type="application/pdf"]').attr('href')
          || undefined
        const canonicalUrl = ensureArxivAbs(idText) ?? idText
        return {
          id: canonicalUrl,
          title,
          canonicalUrl,
          htmlUrl: ensureArxivHtml(idText),
          pdfUrl,
          abstract
        }
      })
      .filter((candidate): candidate is PaperCandidate => candidate !== null)
      .filter((candidate) => Boolean(candidate.htmlUrl || candidate.pdfUrl || candidate.abstract))
      .slice(0, 3)

    cache[cacheKey] = {
      candidates,
      fetchedAt: new Date().toISOString()
    }
    writeJsonCache(paperSearchCachePath, cache)
    return candidates
  } catch {
    return []
  }
}

function paperRankCacheKey(record: {
  nodeId: string
  title: string
  topic: string
  summary: string
  keyConcepts: string[]
}, candidates: PaperCandidate[]) {
  return `v1:${normalizeText(`${record.nodeId}\n${record.title}\n${record.topic}\n${record.summary}\n${record.keyConcepts.join(' ')}\n${candidates.map((candidate) => `${candidate.id} ${candidate.title} ${candidate.abstract ?? ''}`).join('\n')}`)}`
}

async function rerankPaperCandidates(record: {
  nodeId: string
  title: string
  topic: string
  summary: string
  keyConcepts: string[]
}, candidates: PaperCandidate[]) {
  if (candidates.length <= 1) return candidates

  const cache = readJsonCache<PaperRankCacheEntry>(paperRankCachePath)
  const cacheKey = paperRankCacheKey(record, candidates)
  const cached = cache[cacheKey]
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 24 * 60 * 60 * 1000) {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const ranked = cached.rankedIds
      .map((id) => byId.get(id))
      .filter((candidate): candidate is PaperCandidate => Boolean(candidate))
    if (ranked.length > 0) return ranked
  }

  const systemPrompt = [
    'Rerank research paper candidates for a wiki topic.',
    'Prefer papers that directly explain or support the core technical idea of the wiki.',
    'Avoid papers that only match an ambiguous abbreviation or a shallow keyword.',
    'Return up to 3 candidate ids in descending relevance.',
    'Return JSON only: {"rankedIds":[string]}'
  ].join(' ')

  const payload = {
    wiki: {
      title: record.title,
      topic: record.topic,
      summary: record.summary,
      keyConcepts: record.keyConcepts.slice(0, 8)
    },
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      abstract: snippet(candidate.abstract ?? '', 320),
      canonicalUrl: candidate.canonicalUrl
    }))
  }

  try {
    let raw: string | undefined
    if (useCodexAuth) {
      raw = JSON.stringify(await runCodexJson<Record<string, unknown>>({
        instructions: systemPrompt,
        input: JSON.stringify(payload)
      }))
    } else {
      const response = await client.chat.completions.create({
        model: defaultModel,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
      raw = response.choices[0]?.message?.content ?? undefined
    }
    const parsed = raw ? JSON.parse(raw) as { rankedIds?: string[] } : {}
    const rankedIds = Array.from(new Set(parsed.rankedIds ?? [])).slice(0, 3)
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const ranked = rankedIds
      .map((id) => byId.get(id))
      .filter((candidate): candidate is PaperCandidate => Boolean(candidate))
    const nextRanked = ranked.length > 0 ? ranked : candidates.slice(0, 3)
    cache[cacheKey] = {
      rankedIds: nextRanked.map((candidate) => candidate.id),
      fetchedAt: new Date().toISOString()
    }
    writeJsonCache(paperRankCachePath, cache)
    return nextRanked
  } catch {
    return candidates.slice(0, 3)
  }
}

function extractHtmlParagraphs(html: string) {
  const $ = load(html)
  $('script, style, nav, footer, header, aside, .references, #references').remove()
  const scope = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body')
  const paragraphs = scope
    .find('p')
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter((paragraph) => paragraph.length >= 140)
  return Array.from(new Set(paragraphs))
}

function extractPdfParagraphs(text: string) {
  return text
    .split(/\n\s*\n/g)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter((paragraph) => paragraph.length >= 180 && paragraph.length <= 1800)
}

function scoreParagraph(queryTokens: string[], paragraph: string, index: number, total: number) {
  const paragraphTokens = extractTokens(paragraph)
  const overlap = overlapScore(queryTokens, paragraphTokens)
  const lexical = jaccard(queryTokens, paragraphTokens)
  const introBias = index < 8 ? 0.2 : 0
  const outroBias = index >= Math.max(0, total - 4) ? 0.1 : 0
  return overlap * 1.25 + lexical + introBias + outroBias
}

function selectRelevantParagraphs(queryTokens: string[], paragraphs: string[]) {
  return paragraphs
    .map((paragraph, index) => ({
      paragraph,
      score: scoreParagraph(queryTokens, paragraph, index, paragraphs.length)
    }))
    .filter((entry) => entry.score > 0.2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map((entry) => snippet(entry.paragraph, 420))
}

async function resolvePaperContent(candidate: PaperCandidate, queryTokens: string[]) {
  const cache = readJsonCache<PaperContentCacheEntry>(paperContentCachePath)
  const cacheKey = candidate.canonicalUrl
  const cached = cache[cacheKey]
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 7 * 24 * 60 * 60 * 1000) {
    return cached.result
  }

  const attempts: Array<() => Promise<PaperExtractedContent | null>> = []
  if (candidate.htmlUrl) {
    attempts.push(async () => {
      const html = await fetchText(candidate.htmlUrl!)
      const paragraphs = selectRelevantParagraphs(queryTokens, extractHtmlParagraphs(html))
      if (paragraphs.length === 0) return null
      return {
        title: candidate.title,
        canonicalUrl: candidate.canonicalUrl,
        extractionMode: 'html_full',
        paragraphs
      }
    })
  }
  if (candidate.pdfUrl) {
    attempts.push(async () => {
      const buffer = Buffer.from(await fetchArrayBuffer(candidate.pdfUrl!))
      const parsed = await pdf(buffer)
      const paragraphs = selectRelevantParagraphs(queryTokens, extractPdfParagraphs(parsed.text))
      if (paragraphs.length === 0) return null
      return {
        title: candidate.title,
        canonicalUrl: candidate.canonicalUrl,
        extractionMode: 'pdf_full',
        paragraphs
      }
    })
  }
  if (candidate.abstract) {
    const abstract = candidate.abstract
    attempts.push(async () => ({
      title: candidate.title,
      canonicalUrl: candidate.canonicalUrl,
      extractionMode: 'abstract_only',
      paragraphs: [snippet(abstract, 420)]
    }))
  }

  for (const attempt of attempts) {
    try {
      const result = await attempt()
      if (!result) continue
      cache[cacheKey] = {
        result,
        fetchedAt: new Date().toISOString()
      }
      writeJsonCache(paperContentCachePath, cache)
      return result
    } catch {
      continue
    }
  }

  return null
}

async function fetchWikipediaSupportSources(term: string, ownerWikiId: string) {
  const normalized = term.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const languageHost = hasHangul(normalized) ? 'ko.wikipedia.org' : 'en.wikipedia.org'
  const cacheKey = `${languageHost}:${normalizeText(normalized)}`
  const cache = readJsonCache<WebCacheEntry>(webCachePath)
  const cached = cache[cacheKey]
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 24 * 60 * 60 * 1000) {
    return cached.notes.map((note, index) => ({
      id: `${cacheKey}:web:${index + 1}`,
      ownerWikiId,
      type: 'web' as const,
      title: normalized,
      url: `https://${languageHost}/wiki/${encodeURIComponent(normalized.replace(/\s+/g, '_'))}`,
      extractionMode: 'web_note' as const,
      excerpt: note
    }))
  }

  try {
    const searchData = await fetchJson<{ pages?: Array<{ key?: string; title?: string; description?: string }> }>(
      `https://${languageHost}/w/rest.php/v1/search/title?q=${encodeURIComponent(normalized)}&limit=2`
    )
    const notes: string[] = []
    const sources: GraphifySupportSource[] = []

    for (const page of (searchData.pages ?? []).slice(0, 2)) {
      if (!page.key) continue
      const summary = await fetchJson<{ title?: string; extract?: string; content_urls?: { desktop?: { page?: string } } }>(
        `https://${languageHost}/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`
      )
      const excerpt = normalizeWhitespace(summary.extract ?? page.description ?? '')
      if (!excerpt) continue
      notes.push(`${summary.title ?? page.title ?? normalized}: ${snippet(excerpt, 180)}`)
      sources.push({
        id: `${cacheKey}:web:${sources.length + 1}`,
        ownerWikiId,
        type: 'web',
        title: summary.title ?? page.title ?? normalized,
        url: summary.content_urls?.desktop?.page ?? `https://${languageHost}/wiki/${encodeURIComponent(page.key)}`,
        extractionMode: 'web_note',
        excerpt: snippet(excerpt, 220)
      })
      if (sources.length >= 2) break
    }

    cache[cacheKey] = { notes, fetchedAt: new Date().toISOString() }
    writeJsonCache(webCachePath, cache)
    return sources
  } catch {
    return []
  }
}

async function buildWikiPaperFirstContext(record: {
  nodeId: string
  title: string
  topic: string
  summary: string
  keyConcepts: string[]
}) {
  const queries = await generatePaperSearchQueries(record)
  const queryTokens = extractTokens(queries.join(' '))
  const arxivCandidateGroups = await Promise.all(
    queries.map((query) => searchArxivCandidates(query))
  )
  const arxivCandidates = Array.from(new Map(
    arxivCandidateGroups.flat().map((candidate) => [candidate.id, candidate])
  ).values())
  const rankedArxivCandidates = await rerankPaperCandidates(record, arxivCandidates)
  const openAlexCandidateGroups = rankedArxivCandidates.length > 0
    ? []
    : await Promise.all(
      Array.from(new Set([...queries, buildWikiPaperQuery(record)].map((query) => normalizeWhitespace(query)).filter(Boolean)))
        .slice(0, 3)
        .map((query) => searchPaperCandidates(query))
    )
  const openAlexCandidates = Array.from(new Map(
    openAlexCandidateGroups.flat().map((candidate) => [candidate.id, candidate])
  ).values())
  const candidates = rankedArxivCandidates.length > 0
    ? rankedArxivCandidates
    : await rerankPaperCandidates(record, openAlexCandidates)

  const paperResults = await Promise.all(
    candidates.map(async (candidate, index) => {
      const content = await resolvePaperContent(candidate, queryTokens)
      if (!content) return []
      return content.paragraphs.map((paragraph, paragraphIndex) => ({
        id: `${record.nodeId}:paper:${index + 1}:${paragraphIndex + 1}`,
        ownerWikiId: record.nodeId,
        type: 'paper' as const,
        title: content.title,
        url: content.canonicalUrl,
        extractionMode: content.extractionMode,
        excerpt: paragraph
      } satisfies GraphifySupportSource))
    })
  )

  const paperSources = paperResults.flat().slice(0, 6)
  if (paperSources.length > 0) return paperSources

  const fallbackTerms = Array.from(
    new Set([record.title, record.topic, ...record.keyConcepts.slice(0, 3)].map((value) => value.trim()).filter(Boolean))
  ).slice(0, 3)

  const webResults = await Promise.all(
    fallbackTerms.map((term) => fetchWikipediaSupportSources(term, record.nodeId))
  )
  return webResults.flat().slice(0, 4)
}

function latestSourceTimestamp(scraps: Scrap[], drafts: WikiDraft[]) {
  return Math.max(
    0,
    ...scraps.map((scrap) => new Date(scrap.updatedAt || scrap.capturedAt).getTime()),
    ...drafts.map((draft) => new Date(draft.updatedAt).getTime())
  )
}

function computeStale(generatedAt: string | null, scraps: Scrap[], drafts: WikiDraft[]) {
  if (!generatedAt) return true
  return latestSourceTimestamp(scraps, drafts) > new Date(generatedAt).getTime()
}

function makeNode(
  id: string,
  kind: GraphifyNode['kind'],
  label: string,
  options: {
    refId?: string | null
    provenance?: GraphifyProvenance
    confidence?: number
    summary?: string
    metadata?: Record<string, unknown>
  } = {}
): GraphifyNode {
  return {
    id,
    kind,
    label,
    refId: options.refId ?? null,
    provenance: options.provenance ?? 'EXTRACTED',
    confidence: options.confidence ?? 1,
    degree: 0,
    clusterId: null,
    summary: options.summary,
    metadata: options.metadata
  }
}

function makeEdge(
  source: string,
  target: string,
  relation: GraphifyEdgeRelation,
  options: {
    provenance?: GraphifyProvenance
    confidence?: number
    weight?: number
    explanation?: string
    ideaSuggestion?: string
    supportingSources?: GraphifySupportSource[]
  } = {}
): GraphifyEdge {
  const safeSource = source < target ? source : target
  const safeTarget = source < target ? target : source
  return {
    id: `${safeSource}::${relation}::${safeTarget}`,
    source,
    target,
    relation,
    provenance: options.provenance ?? 'EXTRACTED',
    confidence: options.confidence ?? 1,
    weight: options.weight ?? 1,
    explanation: options.explanation,
    ideaSuggestion: options.ideaSuggestion,
    supportingSources: options.supportingSources
  }
}

function classifySupportLevel(level: string): GraphifyEdgeRelation | null {
  if (level === 'supported') return 'supports'
  if (level === 'conflicting') return 'conflicts_with'
  return null
}

function clusterLabel(nodes: GraphifyNode[]) {
  const concepts = nodes.filter((node) => node.kind === 'concept').map((node) => node.label)
  if (concepts.length > 0) return concepts.slice(0, 3).join(' / ')
  const wikis = nodes.filter((node) => node.kind === 'wiki').map((node) => node.label)
  if (wikis.length > 0) return wikis[0]
  return nodes.slice(0, 2).map((node) => node.label).join(' / ')
}

function buildClusters(nodes: GraphifyNode[], edges: GraphifyEdge[]) {
  const labels = new Map<string, string>()
  const adjacency = new Map<string, Array<{ id: string; weight: number }>>()
  nodes.forEach((node) => {
    labels.set(node.id, node.id)
    adjacency.set(node.id, [])
  })
  edges.forEach((edge) => {
    adjacency.get(edge.source)?.push({ id: edge.target, weight: edge.weight })
    adjacency.get(edge.target)?.push({ id: edge.source, weight: edge.weight })
  })

  for (let iteration = 0; iteration < 8; iteration += 1) {
    let changed = false
    for (const node of nodes) {
      const counts = new Map<string, number>()
      const neighbors = adjacency.get(node.id) ?? []
      neighbors.forEach((neighbor) => {
        const label = labels.get(neighbor.id) ?? neighbor.id
        counts.set(label, (counts.get(label) ?? 0) + neighbor.weight)
      })
      if (counts.size === 0) continue
      const nextLabel = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
      if (nextLabel && nextLabel !== labels.get(node.id)) {
        labels.set(node.id, nextLabel)
        changed = true
      }
    }
    if (!changed) break
  }

  const grouped = new Map<string, GraphifyNode[]>()
  nodes.forEach((node) => {
    const label = labels.get(node.id) ?? node.id
    const bucket = grouped.get(label) ?? []
    bucket.push(node)
    grouped.set(label, bucket)
  })

  const clusters = [...grouped.values()]
    .sort((left, right) => right.length - left.length)
    .map((group, index) => {
      const id = `cluster_${index + 1}`
      group.forEach((node) => {
        node.clusterId = id
      })
      return {
        id,
        label: clusterLabel(group),
        color: clusterColors[index % clusterColors.length],
        nodeIds: group.map((node) => node.id)
      } satisfies GraphifyCluster
    })

  return clusters
}

async function inferSurprisingConnections(
  nodes: GraphifyNode[],
  edges: GraphifyEdge[],
  drafts: WikiDraft[]
) {
  const wikiRecords = drafts
    .map((draft) => {
      const node = nodes.find((candidate) => candidate.id === `wiki:${draft.id}`)
      if (!node) return null
      return {
        nodeId: node.id,
        label: node.label,
        title: draft.title,
        topic: draft.topic,
        summary: draft.summary,
        keyConcepts: draft.keyConcepts.slice(0, 8)
      }
    })
    .filter(Boolean) as Array<{
      nodeId: string
      label: string
      title: string
      topic: string
      summary: string
      keyConcepts: string[]
      supportingSources?: GraphifySupportSource[]
    }>

  const enrichedWikiRecords = await Promise.all(
    wikiRecords.map(async (record) => ({
      ...record,
      supportingSources: await buildWikiPaperFirstContext(record)
    }))
  )

  if (wikiRecords.length < 2) {
    edges.forEach((edge) => {
      edge.surprising = false
      edge.surprisingScore = undefined
    })
    return []
  }

  const systemPrompt = [
    'You identify surprising knowledge graph connections between wiki summaries using paper-first evidence.',
    'Only consider wiki-to-wiki links.',
    'Use the overall idea, design pattern, conceptual overlap, or hidden strategic similarity.',
    'Do not rely on shallow lexical similarity alone.',
    'Use the provided supporting sources as evidence. These are paper excerpts first, then optional web fallback notes.',
    'Allowed relations: related_to, supports, conflicts_with, about.',
    'For each surprising pair, explain why the connection is interesting and suggest one concrete idea that combines the two wiki themes.',
    'The idea should sound like: "이런 점이 결합되는데, 이러면 어떨까요?" and be actionable rather than abstract.',
    'For each edge, return up to 4 supportingSourceIds chosen only from the supplied supportingSources of the two wikis.',
    'Return only JSON in this format: {"surprising_edges":[{"leftId":string,"rightId":string,"relation":string,"confidence":number,"reason":string,"ideaSuggestion":string,"supportingSourceIds":[string]}]}',
    'Use the provided wiki node ids exactly. Return at most 8 surprising edges.'
  ].join(' ')

  let raw: string | undefined

  if (useCodexAuth) {
    raw = JSON.stringify(await runCodexJson<Record<string, unknown>>({
      instructions: systemPrompt,
      input: JSON.stringify({ wikis: enrichedWikiRecords })
    }))
  } else {
    // --- 기존: Chat Completions API ---
    const response = await client.chat.completions.create({
      model: defaultModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({ wikis: enrichedWikiRecords }) }
      ]
    })
    raw = response.choices[0]?.message?.content ?? undefined
  }
  if (!raw) {
    edges.forEach((edge) => {
      edge.surprising = false
      edge.surprisingScore = undefined
    })
    return []
  }

  const parsed = JSON.parse(raw) as {
    surprising_edges?: Array<{
      leftId: string
      rightId: string
      relation: string
      confidence?: number
      reason?: string
      ideaSuggestion?: string
      supportingSourceIds?: string[]
    }>
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const wikiById = new Map(enrichedWikiRecords.map((wiki) => [wiki.nodeId, wiki]))
  const wikiIdSet = new Set(enrichedWikiRecords.map((wiki) => wiki.nodeId))
  const nextSurprisingIds = new Set<string>()
  const surprisingConnections: GraphifySurprisingConnection[] = []

  edges.forEach((edge) => {
    edge.surprising = false
    edge.surprisingScore = undefined
  })

  for (const item of parsed.surprising_edges ?? []) {
    if (!wikiIdSet.has(item.leftId) || !wikiIdSet.has(item.rightId)) continue
    if (item.leftId === item.rightId) continue
    if (!['related_to', 'supports', 'conflicts_with', 'about'].includes(item.relation)) continue

    const confidence = typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.72
    const availableSources = [
      ...(wikiById.get(item.leftId)?.supportingSources ?? []),
      ...(wikiById.get(item.rightId)?.supportingSources ?? [])
    ]
    const supportingSources = (item.supportingSourceIds ?? [])
      .map((sourceId) => availableSources.find((source) => source.id === sourceId))
      .filter((source): source is GraphifySupportSource => Boolean(source))
      .slice(0, 4)
    const edgeId = `${item.leftId < item.rightId ? item.leftId : item.rightId}::${item.relation}::${item.leftId < item.rightId ? item.rightId : item.leftId}`
    let edge = edges.find((current) => current.id === edgeId)
    if (!edge) {
      edge = makeEdge(item.leftId, item.rightId, item.relation as GraphifyEdgeRelation, {
        provenance: 'INFERRED',
        confidence,
        weight: Math.max(1, Math.round(confidence * 3)),
        explanation: item.reason?.slice(0, 240),
        ideaSuggestion: item.ideaSuggestion?.slice(0, 240),
        supportingSources
      })
      edges.push(edge)
    } else {
      edge.explanation = item.reason?.slice(0, 240) ?? edge.explanation
      edge.ideaSuggestion = item.ideaSuggestion?.slice(0, 240) ?? edge.ideaSuggestion
      edge.supportingSources = supportingSources.length > 0 ? supportingSources : edge.supportingSources
      edge.confidence = Math.max(edge.confidence, confidence)
    }
    edge.surprising = true
    edge.surprisingScore = confidence
    nextSurprisingIds.add(edge.id)

    const left = nodeById.get(item.leftId)
    const right = nodeById.get(item.rightId)
    if (!left || !right) continue
    surprisingConnections.push({
      edgeId: edge.id,
      sourceId: left.id,
      sourceLabel: left.label,
      targetId: right.id,
      targetLabel: right.label,
      relation: edge.relation,
      confidence,
      explanation: item.reason?.slice(0, 240),
      ideaSuggestion: item.ideaSuggestion?.slice(0, 240),
      supportingSources
    })
  }

  edges.forEach((edge) => {
    if (!nextSurprisingIds.has(edge.id)) {
      edge.surprising = false
      edge.surprisingScore = undefined
    }
  })

  return surprisingConnections.slice(0, 8)
}

function computeDegrees(nodes: GraphifyNode[], edges: GraphifyEdge[]) {
  const degreeMap = new Map<string, number>()
  nodes.forEach((node) => degreeMap.set(node.id, 0))
  edges.forEach((edge) => {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + edge.weight)
    degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + edge.weight)
  })
  nodes.forEach((node) => {
    node.degree = degreeMap.get(node.id) ?? 0
  })
}

async function inferSemanticEdges(nodes: GraphifyNode[], edges: GraphifyEdge[]) {
  const directlyConnected = new Set(edges.map((edge) => `${edge.source}::${edge.target}`))
  const semanticNodes = nodes.filter((node) => node.kind === 'claim' || node.kind === 'concept' || node.kind === 'wiki')
  const candidates: Array<{ leftId: string; rightId: string; leftLabel: string; rightLabel: string }> = []

  for (let left = 0; left < semanticNodes.length; left += 1) {
    for (let right = left + 1; right < semanticNodes.length; right += 1) {
      const a = semanticNodes[left]
      const b = semanticNodes[right]
      if (a.kind === 'wiki' && b.kind === 'wiki' && a.refId === b.refId) continue
      if (directlyConnected.has(`${a.id}::${b.id}`) || directlyConnected.has(`${b.id}::${a.id}`)) continue
      const leftTokens = extractTokens(`${a.label}\n${a.summary ?? ''}`)
      const rightTokens = extractTokens(`${b.label}\n${b.summary ?? ''}`)
      const overlap = overlapScore(leftTokens, rightTokens)
      const score = Math.max(jaccard(leftTokens, rightTokens), overlap / Math.max(1, Math.min(leftTokens.length, rightTokens.length)))
      if (overlap < 2 && score < 0.22) continue
      candidates.push({ leftId: a.id, rightId: b.id, leftLabel: a.label, rightLabel: b.label })
      if (candidates.length >= 18) break
    }
    if (candidates.length >= 18) break
  }

  if (candidates.length === 0) return []

  const systemPrompt = [
    'You classify possible graph edges between knowledge nodes.',
    'Only classify the supplied candidate pairs.',
    'Allowed relations: related_to, supports, conflicts_with, unrelated.',
    'Return JSON only: {"edges":[{"leftId":string,"rightId":string,"relation":string,"confidence":number,"explanation":string}]}'
  ].join(' ')

  let raw: string | undefined

  if (useCodexAuth) {
    raw = JSON.stringify(await runCodexJson<Record<string, unknown>>({
      instructions: systemPrompt,
      input: JSON.stringify({ candidates })
    }))
  } else {
    // --- 기존: Chat Completions API ---
    const response = await client.chat.completions.create({
      model: defaultModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({ candidates }) }
      ]
    })
    raw = response.choices[0]?.message?.content ?? undefined
  }
  if (!raw) return []
  const parsed = JSON.parse(raw) as { edges?: Array<{ leftId: string; rightId: string; relation: string; confidence?: number; explanation?: string }> }
  const validIds = new Set(candidates.flatMap((candidate) => [candidate.leftId, candidate.rightId]))
  return (parsed.edges ?? [])
    .filter((item) => validIds.has(item.leftId) && validIds.has(item.rightId))
    .filter((item) => ['related_to', 'supports', 'conflicts_with'].includes(item.relation))
    .map((item) => makeEdge(item.leftId, item.rightId, item.relation as GraphifyEdgeRelation, {
      provenance: 'INFERRED',
      confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.68,
      weight: typeof item.confidence === 'number' ? Math.max(1, Math.round(item.confidence * 4)) : 2,
      explanation: item.explanation?.slice(0, 240)
    }))
}

export async function rebuildGraphifyPayload() {
  // Rebuild the graph from persisted scraps/wiki drafts so Graphify is always derivable from local state.
  const scraps = listScraps(500)
  const drafts = listWikiDrafts(500)
  const nodes = new Map<string, GraphifyNode>()
  const edges = new Map<string, GraphifyEdge>()
  const conceptNodeIds = new Map<string, string>()

  scraps.forEach((scrap) => {
    const nodeId = `scrap:${scrap.id}`
    nodes.set(nodeId, makeNode(nodeId, 'scrap', scrap.title, {
      refId: scrap.id,
      summary: snippet(scrap.mergedText),
      metadata: {
        sourceHost: scrap.sourceHost,
        capturedAt: scrap.capturedAt,
        tags: scrap.tags
      }
    }))
  })

  drafts.forEach((draft) => {
    const wikiNodeId = `wiki:${draft.id}`
    nodes.set(wikiNodeId, makeNode(wikiNodeId, 'wiki', draft.title, {
      refId: draft.id,
      summary: snippet(draft.summary),
      metadata: {
        topic: draft.topic,
        status: draft.status,
        mode: draft.mode,
        scrapCount: draft.scrapIds.length
      }
    }))

    draft.scrapIds.forEach((scrapId) => {
      const scrapNodeId = `scrap:${scrapId}`
      if (nodes.has(scrapNodeId)) {
        const edge = makeEdge(wikiNodeId, scrapNodeId, 'summarizes', { weight: 2 })
        edges.set(edge.id, edge)
      }
    })

    // Expand each wiki into concept and claim nodes so the graph can bridge raw scraps and summarized knowledge.
    draft.keyConcepts.forEach((concept) => {
      const normalized = normalizeText(concept).trim() || concept.trim().toLowerCase()
      if (!normalized) return
      const conceptNodeId = conceptNodeIds.get(normalized) ?? `concept:${conceptNodeIds.size + 1}`
      if (!conceptNodeIds.has(normalized)) {
        conceptNodeIds.set(normalized, conceptNodeId)
        nodes.set(conceptNodeId, makeNode(conceptNodeId, 'concept', concept, {
          summary: `위키 개념 노드: ${concept}`
        }))
      }
      const edge = makeEdge(wikiNodeId, conceptNodeId, 'contains_concept', { weight: 2 })
      edges.set(edge.id, edge)
    })

    draft.claims.forEach((claim, index) => {
      const claimNodeId = `claim:${draft.id}:${index}`
      nodes.set(claimNodeId, makeNode(claimNodeId, 'claim', claim.claim, {
        summary: snippet(claim.evidence.join(' · ') || claim.claim),
        metadata: {
          supportLevel: claim.supportLevel,
          relatedScrapIds: claim.relatedScrapIds
        }
      }))
      const claimEdge = makeEdge(wikiNodeId, claimNodeId, 'contains_claim', { weight: 2 })
      edges.set(claimEdge.id, claimEdge)
      claim.relatedScrapIds.forEach((scrapId) => {
        const scrapNodeId = `scrap:${scrapId}`
        if (nodes.has(scrapNodeId)) {
          const edge = makeEdge(claimNodeId, scrapNodeId, 'derived_from', { weight: 1.5 })
          edges.set(edge.id, edge)
        }
      })
      const supportRelation = classifySupportLevel(claim.supportLevel)
      if (supportRelation && claim.relatedScrapIds.length > 1) {
        for (let left = 0; left < claim.relatedScrapIds.length; left += 1) {
          for (let right = left + 1; right < claim.relatedScrapIds.length; right += 1) {
            const leftNode = `scrap:${claim.relatedScrapIds[left]}`
            const rightNode = `scrap:${claim.relatedScrapIds[right]}`
            if (nodes.has(leftNode) && nodes.has(rightNode)) {
              const edge = makeEdge(leftNode, rightNode, supportRelation, { weight: 1 })
              edges.set(edge.id, edge)
            }
          }
        }
      }
    })
  })

  const conceptEntries = [...conceptNodeIds.entries()]
  // Attach scraps back to concept nodes with lightweight lexical matching so raw evidence stays connected to wiki concepts.
  scraps.forEach((scrap) => {
    const scrapNodeId = `scrap:${scrap.id}`
    const scrapTokens = extractTokens(`${scrap.title}\n${scrap.pageTitle}\n${scrap.mergedText.slice(0, 2200)}`)
    conceptEntries.forEach(([normalized, conceptNodeId]) => {
      const conceptTokens = extractTokens(normalized)
      const overlap = overlapScore(scrapTokens, conceptTokens)
      if (overlap === 0) return
      const edge = makeEdge(scrapNodeId, conceptNodeId, 'mentions_concept', { weight: Math.max(1, overlap) })
      edges.set(edge.id, edge)
    })
  })

  // Semantic edges are inferred after deterministic graph construction so LLM output augments, rather than replaces, extracted structure.
  const inferredEdges = await inferSemanticEdges([...nodes.values()], [...edges.values()])
  inferredEdges.forEach((edge) => {
    if (!edges.has(edge.id)) {
      edges.set(edge.id, edge)
    }
  })

  const nodeList = [...nodes.values()]
  const edgeList = [...edges.values()]
  computeDegrees(nodeList, edgeList)
  const clusters = buildClusters(nodeList, edgeList)
  let godNodes = nodeList
    .slice()
    .sort((left, right) => right.degree - left.degree)
    .slice(0, 5)
    .map((node) => ({ nodeId: node.id, label: node.label, degree: node.degree, kind: node.kind } satisfies GraphifyGodNode))
  // Surprising connections are a second-pass wiki-to-wiki analysis layered on top of the rebuilt graph.
  const surprisingConnections = await inferSurprisingConnections(nodeList, edgeList, drafts)
  computeDegrees(nodeList, edgeList)
  godNodes = nodeList
    .slice()
    .sort((left, right) => right.degree - left.degree)
    .slice(0, 5)
    .map((node) => ({ nodeId: node.id, label: node.label, degree: node.degree, kind: node.kind } satisfies GraphifyGodNode))

  const payload: GraphifyPayload = {
    nodes: nodeList,
    edges: edgeList,
    clusters,
    godNodes,
    surprisingConnections,
    generatedAt: new Date().toISOString(),
    stale: false
  }

  writeCache(payload)
  return payload
}

export function getGraphifyPayload() {
  const scraps = listScraps(500)
  const drafts = listWikiDrafts(500)
  const cached = readCache()
  if (!cached) {
    return {
      nodes: [],
      edges: [],
      clusters: [],
      godNodes: [],
      surprisingConnections: [],
      generatedAt: null,
      stale: scraps.length > 0 || drafts.length > 0
    } satisfies GraphifyPayload
  }
  return {
    ...cached,
    stale: computeStale(cached.generatedAt, scraps, drafts)
  }
}

export function getGraphifyNodeDetail(nodeId: string) {
  const payload = getGraphifyPayload()
  const node = payload.nodes.find((item) => item.id === nodeId)
  if (!node) return null
  const neighbors = payload.edges
    .filter((edge) => edge.source === nodeId || edge.target === nodeId)
    .map((edge) => ({
      edge,
      node: payload.nodes.find((candidate) => candidate.id === (edge.source === nodeId ? edge.target : edge.source))
    }))
    .filter((entry): entry is { edge: GraphifyEdge; node: GraphifyNode } => Boolean(entry.node))
    .sort((left, right) => right.node.degree - left.node.degree)
    .slice(0, 20)
  return { node, neighbors } satisfies GraphifyNodeDetail
}

export function getGraphContextForPrompt(prompt: string) {
  const payload = getGraphifyPayload()
  if (payload.nodes.length === 0) {
    return {
      wikiIds: [] as string[],
      scrapIds: [] as string[],
      matchedNodeIds: [] as string[],
      surprisingConnections: [] as Array<{
        sourceLabel: string
        targetLabel: string
        relation: GraphifyEdgeRelation
        confidence: number
        explanation?: string
        ideaSuggestion?: string
        supportingSources?: GraphifySupportSource[]
      }>
    }
  }

  const promptTokens = extractTokens(prompt)
  const scored = payload.nodes
    .map((node) => {
      const nodeTokens = extractTokens(`${node.label}\n${node.summary ?? ''}`)
      const overlap = overlapScore(promptTokens, nodeTokens)
      const score = overlap + jaccard(promptTokens, nodeTokens)
      return { node, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)

  const matchedNodeIds = new Set(scored.map((entry) => entry.node.id))
  const edgeNeighbors = payload.edges.filter((edge) => matchedNodeIds.has(edge.source) || matchedNodeIds.has(edge.target))
  edgeNeighbors.forEach((edge) => {
    matchedNodeIds.add(edge.source)
    matchedNodeIds.add(edge.target)
  })

  const wikiIds = new Set<string>()
  const scrapIds = new Set<string>()
  payload.nodes
    .filter((node) => matchedNodeIds.has(node.id))
    .forEach((node) => {
      if (node.kind === 'wiki' && node.refId) wikiIds.add(node.refId)
      if (node.kind === 'scrap' && node.refId) scrapIds.add(node.refId)
    })

  const surprisingConnections = payload.surprisingConnections
    .map((connection) => {
      const leftTokens = extractTokens(`${connection.sourceLabel}\n${connection.explanation ?? ''}`)
      const rightTokens = extractTokens(`${connection.targetLabel}\n${connection.explanation ?? ''}`)
      const score = overlapScore(promptTokens, [...leftTokens, ...rightTokens]) +
        jaccard(promptTokens, [...leftTokens, ...rightTokens])
      return { connection, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((entry) => ({
      sourceLabel: entry.connection.sourceLabel,
      targetLabel: entry.connection.targetLabel,
      relation: entry.connection.relation,
      confidence: entry.connection.confidence,
      explanation: entry.connection.explanation,
      ideaSuggestion: entry.connection.ideaSuggestion,
      supportingSources: entry.connection.supportingSources
    }))

  return {
    wikiIds: [...wikiIds].slice(0, 6),
    scrapIds: [...scrapIds].slice(0, 8),
    matchedNodeIds: [...matchedNodeIds].slice(0, 16),
    surprisingConnections
  }
}
