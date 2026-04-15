import { load } from 'cheerio'

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  sourceHost: string
}

export interface WebPageBundle {
  url: string
  title: string
  sourceHost: string
  excerpt: string
  evidenceSentences: string[]
}

const USER_AGENT = 'ClipWiki/0.1 (+https://github.com/leehogwang/scrap-to-llmwiki-rag-agent)'

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function snippet(value: string, maxLength = 800) {
  return normalizeWhitespace(value).slice(0, maxLength)
}

function extractQueryTokens(query: string) {
  return [...new Set(
    (query.match(/[A-Za-z][A-Za-z0-9_-]{1,}|[가-힣]{2,}/g) ?? [])
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 2)
  )]
}

function splitIntoSentences(text: string) {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter((sentence) => sentence.length >= 40)
}

function collectEvidenceCandidates(html: string) {
  const $ = load(html)
  const candidates: string[] = []
  const selectors = [
    'main p',
    'article p',
    'p',
    'main li',
    'article li',
    'li',
    'table tr',
    'td',
    'th',
    'main div',
    'article div',
    'div',
    'span'
  ]

  for (const selector of selectors) {
    $(selector).each((_, node) => {
      const text = normalizeWhitespace($(node).text())
      if (!text) return
      if (text.length < 18 || text.length > 420) return
      candidates.push(text)
    })
  }

  return [...new Set(candidates)]
}

function scoreEvidenceSentence(sentence: string, queryTokens: string[]) {
  const normalized = sentence.toLowerCase()
  const overlap = queryTokens.reduce((count, token) => count + (normalized.includes(token) ? 1 : 0), 0)
  const numericBonus = /(?:\$|usd|krw|달러|원|%|20\d{2}|v?\d+\.\d+)/i.test(sentence) ? 2 : 0
  const policyBonus = /(price|pricing|policy|version|release|update|가격|요금|정책|버전|출시|업데이트)/i.test(sentence) ? 2 : 0
  return overlap * 3 + numericBonus + policyBonus
}

function extractEvidenceSentences(text: string, query: string, maxItems = 6) {
  const queryTokens = extractQueryTokens(query)
  const candidates = [...new Set([
    ...splitIntoSentences(text),
    ...text
      .split('\n')
      .map((line) => normalizeWhitespace(line))
      .filter((line) => line.length >= 18)
  ])]
  const scored = candidates
    .map((sentence) => ({
      sentence,
      score: scoreEvidenceSentence(sentence, queryTokens)
    }))
    .sort((left, right) => right.score - left.score)

  const selected = scored
    .filter((entry) => entry.score > 0)
    .slice(0, maxItems)
    .map((entry) => entry.sentence)

  if (selected.length > 0) return selected
  return candidates.slice(0, Math.min(maxItems, 4))
}

function isAllowedUrl(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function decodeDuckDuckGoUrl(rawHref: string) {
  if (!rawHref) return ''
  try {
    const resolved = new URL(rawHref, 'https://duckduckgo.com')
    const redirected = resolved.searchParams.get('uddg')
    return redirected ? decodeURIComponent(redirected) : resolved.toString()
  } catch {
    return rawHref
  }
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  return await response.text()
}

export async function searchWeb(query: string, limit = 5) {
  const normalizedQuery = normalizeWhitespace(query)
  if (!normalizedQuery) return [] as WebSearchResult[]

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(normalizedQuery)}`
  const html = await fetchText(url)
  const $ = load(html)
  const results: WebSearchResult[] = []

  $('.result').each((_, element) => {
    if (results.length >= limit) return false
    const anchor = $(element).find('.result__title a, .result__a').first()
    const href = decodeDuckDuckGoUrl(anchor.attr('href') ?? '')
    if (!isAllowedUrl(href)) return

    const title = normalizeWhitespace(anchor.text())
    if (!title) return

    let sourceHost = ''
    try {
      sourceHost = new URL(href).host
    } catch {
      sourceHost = ''
    }

    const snippetText = normalizeWhitespace(
      $(element).find('.result__snippet').first().text() ||
        $(element).find('.result__extras__url').first().text()
    )

    results.push({
      title,
      url: href,
      snippet: snippetText.slice(0, 320),
      sourceHost
    })
  })

  return results
}

export async function fetchWebPageBundles(urls: string[], query = '') {
  const uniqueUrls = [...new Set(urls.filter(isAllowedUrl))].slice(0, 4)

  const bundles = await Promise.all(
    uniqueUrls.map(async (url) => {
      try {
        const html = await fetchText(url)
        const $ = load(html)
        const title =
          normalizeWhitespace($('title').first().text()) ||
          normalizeWhitespace($('h1').first().text()) ||
          url
        const paragraphs = $('main p, article p, p')
          .toArray()
          .map((node) => normalizeWhitespace($(node).text()))
          .filter((text) => text.length >= 40)
          .slice(0, 8)
        const evidenceCandidates = collectEvidenceCandidates(html)

        const metaDescription = normalizeWhitespace(
          $('meta[name="description"]').attr('content') ||
            $('meta[property="og:description"]').attr('content') ||
            ''
        )

        const fullText = [metaDescription, ...paragraphs, ...evidenceCandidates.slice(0, 80)].filter(Boolean).join('\n')
        const excerpt = snippet(fullText)
        if (!excerpt) return null
        const evidenceSentences = extractEvidenceSentences(fullText, query)

        return {
          url,
          title: snippet(title, 180),
          sourceHost: new URL(url).host,
          excerpt,
          evidenceSentences
        } satisfies WebPageBundle
      } catch {
        return null
      }
    })
  )

  return bundles.filter((bundle): bundle is WebPageBundle => Boolean(bundle))
}
