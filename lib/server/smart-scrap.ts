import type { ScrapCandidateChunk, ScrapChunk, ScrapImageCandidate, SelectionRect } from '@/lib/types'

const MIN_CONTEXT_LENGTH = 32
const MAX_CHUNK_TEXT_LENGTH = 700
const MAX_CANDIDATE_CHUNKS = 120
const MAX_SEMANTIC_CHUNKS = 2
const MAX_SEMANTIC_IMAGES = 6
const MIN_SELECTION_LENGTH = 18
const MIN_SIMILARITY = 0.3
const MIN_SHARED_TOKENS = 2

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function tokenize(text: string) {
  const normalized = normalizeWhitespace(text).toLowerCase()
  if (!normalized) return []
  return normalized.match(/[a-z0-9]+|[가-힣]{2,}/g) ?? []
}

function splitLongChunk(text: string) {
  const normalized = normalizeWhitespace(text)
  if (normalized.length <= MAX_CHUNK_TEXT_LENGTH) return [normalized]

  const sentences = normalized
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean)

  if (sentences.length <= 1) {
    return normalized.match(new RegExp(`.{1,${MAX_CHUNK_TEXT_LENGTH}}`, 'g')) ?? [normalized]
  }

  const groups: string[] = []
  let current = ''

  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence
    if (next.length > MAX_CHUNK_TEXT_LENGTH && current) {
      groups.push(current)
      current = sentence
    } else {
      current = next
    }
  }

  if (current) groups.push(current)
  return groups
}

function mergeTinyChunks(chunks: ScrapCandidateChunk[]) {
  const merged: ScrapCandidateChunk[] = []

  for (const chunk of chunks) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.containerPath === chunk.containerPath &&
      previous.nearestHeading === chunk.nearestHeading &&
      previous.text.length < MIN_CONTEXT_LENGTH &&
      chunk.text.length < MIN_CONTEXT_LENGTH
    ) {
      previous.text = normalizeWhitespace(`${previous.text} ${chunk.text}`)
      previous.intersectsSelection = previous.intersectsSelection || chunk.intersectsSelection
      continue
    }
    merged.push({ ...chunk })
  }

  return merged
}

function normalizeCandidates(candidateChunks: ScrapCandidateChunk[]) {
  const flattened: ScrapCandidateChunk[] = []

  candidateChunks.slice(0, MAX_CANDIDATE_CHUNKS).forEach((chunk, index) => {
    const text = normalizeWhitespace(chunk.text).slice(0, MAX_CHUNK_TEXT_LENGTH * 2)
    if (!text) return

    splitLongChunk(text).forEach((part, partIndex) => {
      flattened.push({
        ...chunk,
        id: partIndex === 0 ? chunk.id : `${chunk.id}:${partIndex + 1}`,
        text: part,
        positionIndex: index * 10 + partIndex
      })
    })
  })

  const deduped = new Map<string, ScrapCandidateChunk>()
  for (const chunk of flattened) {
    const key = `${chunk.containerPath}|${chunk.nearestHeading}|${chunk.text.toLowerCase()}`
    if (!deduped.has(key)) {
      deduped.set(key, chunk)
    }
  }

  return mergeTinyChunks([...deduped.values()]).sort((left, right) => left.positionIndex - right.positionIndex)
}

function cosineSimilarity(left: Map<string, number>, right: Map<string, number>) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0

  for (const value of left.values()) {
    leftNorm += value * value
  }
  for (const value of right.values()) {
    rightNorm += value * value
  }
  for (const [token, leftValue] of left.entries()) {
    const rightValue = right.get(token)
    if (rightValue) {
      dot += leftValue * rightValue
    }
  }

  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function sharedTokenCount(left: string, right: string) {
  const leftTokens = new Set(tokenize(left))
  const rightTokens = new Set(tokenize(right))
  let count = 0

  for (const token of leftTokens) {
    if (rightTokens.has(token)) count += 1
  }

  return count
}

function buildTfIdfVectors(queryText: string, chunks: ScrapCandidateChunk[]) {
  const documents = [queryText, ...chunks.map((chunk) => chunk.text)]
  const tokenized = documents.map((text) => tokenize(text))
  const documentFrequency = new Map<string, number>()

  for (const tokens of tokenized) {
    const uniqueTokens = new Set(tokens)
    uniqueTokens.forEach((token) => {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    })
  }

  const documentCount = documents.length

  return tokenized.map((tokens) => {
    const termFrequency = new Map<string, number>()
    tokens.forEach((token) => {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
    })

    const vector = new Map<string, number>()
    const tokenCount = tokens.length || 1
    for (const [token, count] of termFrequency.entries()) {
      const tf = count / tokenCount
      const df = documentFrequency.get(token) ?? 1
      const idf = Math.log((documentCount + 1) / (df + 1)) + 1
      vector.set(token, tf * idf)
    }

    return vector
  })
}

function uniqueChunks(chunks: ScrapChunk[]) {
  const seen = new Set<string>()
  return chunks.filter((chunk) => {
    if (seen.has(chunk.id)) return false
    seen.add(chunk.id)
    return true
  })
}

function containerDepth(path: string) {
  return path.split('>').filter(Boolean).length
}

function findHeadingContext(chunks: ScrapCandidateChunk[], anchors: ScrapCandidateChunk[]) {
  const headingMap = new Map<string, ScrapCandidateChunk>()
  chunks.forEach((chunk) => {
    if (chunk.domPath.includes('>h') || chunk.domPath.endsWith(':heading')) {
      headingMap.set(chunk.nearestHeading || chunk.text, chunk)
    }
  })

  const context: ScrapChunk[] = []
  anchors.forEach((anchor) => {
    const key = anchor.nearestHeading
    if (!key) return
    const heading = headingMap.get(key)
    if (heading) {
      context.push({ ...heading, reason: 'nearest heading' })
    }
  })

  return context
}

export function enrichSmartScrap(input: {
  selectedText: string
  candidateChunks: ScrapCandidateChunk[]
  imageCandidates?: ScrapImageCandidate[]
  selectionRect?: SelectionRect | null
}) {
  const normalizedSelectedText = normalizeWhitespace(input.selectedText)
  const candidates = normalizeCandidates(input.candidateChunks)

  const anchorSource = candidates.filter((chunk) => chunk.intersectsSelection)
  const anchors = (anchorSource.length > 0
    ? anchorSource
    : candidates.slice(0, 1)
  ).map((chunk) => ({ ...chunk, reason: 'intersects selection' }))

  const anchorIds = new Set(anchors.map((chunk) => chunk.id))
  const anchorIndexMap = new Set(
    anchors
      .map((anchor) => candidates.findIndex((chunk) => chunk.id === anchor.id))
      .filter((index) => index >= 0)
  )

  const contextCandidates = candidates.filter((chunk) => {
    if (anchorIds.has(chunk.id)) return false
    const candidateIndex = candidates.findIndex((item) => item.id === chunk.id)
    const withinWindow = [...anchorIndexMap].some((anchorIndex) => Math.abs(candidateIndex - anchorIndex) <= 1)
    const sameContainer = anchors.some((anchor) =>
      anchor.containerPath === chunk.containerPath && containerDepth(chunk.containerPath) > 1
    )
    const sameHeading = anchors.some((anchor) => anchor.nearestHeading && anchor.nearestHeading === chunk.nearestHeading)
    return withinWindow || sameContainer || sameHeading
  })

  const contextChunks = uniqueChunks([
    ...contextCandidates.map((chunk) => ({ ...chunk, reason: 'structural context' })),
    ...findHeadingContext(candidates, anchors)
  ]).filter((chunk) => !anchorIds.has(chunk.id))

  const semanticChunks: ScrapChunk[] = []
  if (normalizedSelectedText.length >= MIN_SELECTION_LENGTH) {
    const tfIdfVectors = buildTfIdfVectors(normalizedSelectedText, candidates)
    const selectedVector = tfIdfVectors[0]
    const usedIds = new Set([
      ...anchorIds,
      ...contextChunks.map((chunk) => chunk.id)
    ])

    candidates.forEach((chunk, index) => {
      if (usedIds.has(chunk.id)) return
      const score = cosineSimilarity(selectedVector, tfIdfVectors[index + 1])
      const overlap = sharedTokenCount(normalizedSelectedText, chunk.text)
      if (score >= MIN_SIMILARITY && overlap >= MIN_SHARED_TOKENS) {
        semanticChunks.push({
          ...chunk,
          score: Number(score.toFixed(3)),
          reason: 'tf-idf cosine similarity'
        })
      }
    })

    semanticChunks.sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
  }

  const finalSemanticChunks = semanticChunks.slice(0, MAX_SEMANTIC_CHUNKS)
  const selectedImageUrls = selectRelevantImages({
    imageCandidates: input.imageCandidates ?? [],
    anchors,
    contextChunks,
    semanticChunks: finalSemanticChunks
  })
  const mergedParts = [
    normalizedSelectedText,
    ...anchors.map((chunk) => chunk.text),
    ...contextChunks.map((chunk) => chunk.text),
    ...finalSemanticChunks.map((chunk) => chunk.text)
  ].filter(Boolean)

  const mergedText = [...new Set(mergedParts.map((part) => normalizeWhitespace(part)).filter(Boolean))].join('\n\n')

  return {
    selectionRect: input.selectionRect ?? null,
    anchorChunks: uniqueChunks(anchors),
    contextChunks,
    semanticChunks: finalSemanticChunks,
    selectedImageUrls,
    mergedText
  }
}

function selectRelevantImages(input: {
  imageCandidates: ScrapImageCandidate[]
  anchors: ScrapChunk[]
  contextChunks: ScrapChunk[]
  semanticChunks: ScrapChunk[]
}) {
  if (input.imageCandidates.length === 0) return []

  const includedChunks = [...input.anchors, ...input.contextChunks, ...input.semanticChunks]
  if (includedChunks.length === 0) {
    return input.imageCandidates
      .filter((image) => image.intersectsSelection)
      .slice(0, MAX_SEMANTIC_IMAGES)
      .map((image) => image.sourceUrl)
  }

  const headings = new Set(
    includedChunks
      .map((chunk) => chunk.nearestHeading?.trim())
      .filter(Boolean)
  )

  const tops = includedChunks
    .map((chunk) => chunk.top)
    .filter((value): value is number => typeof value === 'number')
  const bottoms = includedChunks
    .map((chunk) => chunk.bottom)
    .filter((value): value is number => typeof value === 'number')

  const minTop = tops.length > 0 ? Math.min(...tops) : null
  const maxBottom = bottoms.length > 0 ? Math.max(...bottoms) : null

  const chosen = input.imageCandidates.filter((image) => {
    if (image.intersectsSelection) return true

    const sameHeading = image.nearestHeading && headings.has(image.nearestHeading.trim())
    const withinVerticalRange = minTop !== null && maxBottom !== null
      ? image.bottom >= minTop - 80 && image.top <= maxBottom + 80
      : false

    return Boolean(sameHeading || withinVerticalRange)
  })

  const deduped = [...new Map(chosen.map((image) => [image.sourceUrl, image])).values()]
  return deduped.slice(0, MAX_SEMANTIC_IMAGES).map((image) => image.sourceUrl)
}
