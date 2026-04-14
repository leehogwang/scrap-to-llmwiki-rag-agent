import fs from 'fs'
import path from 'path'
import OpenAI from 'openai'
import {
  listScraps,
  listWikiDrafts
} from '@/lib/server/db'
import { getOptionalEnv, getRequiredEnv } from '@/lib/server/env'
import type {
  GraphifyCluster,
  GraphifyEdge,
  GraphifyEdgeRelation,
  GraphifyGodNode,
  GraphifyNode,
  GraphifyNodeDetail,
  GraphifyPayload,
  GraphifyProvenance,
  GraphifySurprisingConnection,
  Scrap,
  WikiDraft
} from '@/lib/types'

const dataDir = path.join(process.cwd(), 'data')
const cachePath = path.join(dataDir, 'graphify-cache.json')
const defaultModel = getOptionalEnv('OPENAI_MODEL', 'gpt-4.1-mini')
const client = new OpenAI({ apiKey: getRequiredEnv('OPENAI_API_KEY') })

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
    explanation: options.explanation
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
    }>

  if (wikiRecords.length < 2) {
    edges.forEach((edge) => {
      edge.surprising = false
      edge.surprisingScore = undefined
    })
    return []
  }

  const response = await client.chat.completions.create({
    model: defaultModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You identify surprising knowledge graph connections between wiki summaries.',
          'Only consider wiki-to-wiki links.',
          'Use the overall idea, design pattern, conceptual overlap, or hidden strategic similarity.',
          'Do not rely on shallow lexical similarity alone.',
          'Allowed relations: related_to, supports, conflicts_with, about.',
          'Return only JSON in this format: {"surprising_edges":[{"leftId":string,"rightId":string,"relation":string,"confidence":number,"reason":string}]}',
          'Use the provided wiki node ids exactly. Return at most 8 surprising edges.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({ wikis: wikiRecords })
      }
    ]
  })

  const raw = response.choices[0]?.message?.content
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
    }>
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const wikiIdSet = new Set(wikiRecords.map((wiki) => wiki.nodeId))
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
    const edgeId = `${item.leftId < item.rightId ? item.leftId : item.rightId}::${item.relation}::${item.leftId < item.rightId ? item.rightId : item.leftId}`
    let edge = edges.find((current) => current.id === edgeId)
    if (!edge) {
      edge = makeEdge(item.leftId, item.rightId, item.relation as GraphifyEdgeRelation, {
        provenance: 'INFERRED',
        confidence,
        weight: Math.max(1, Math.round(confidence * 3)),
        explanation: item.reason?.slice(0, 240)
      })
      edges.push(edge)
    } else {
      edge.explanation = item.reason?.slice(0, 240) ?? edge.explanation
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
      explanation: item.reason?.slice(0, 240)
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

  const response = await client.chat.completions.create({
    model: defaultModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: [
          'You classify possible graph edges between knowledge nodes.',
          'Only classify the supplied candidate pairs.',
          'Allowed relations: related_to, supports, conflicts_with, unrelated.',
          'Return JSON only: {"edges":[{"leftId":string,"rightId":string,"relation":string,"confidence":number,"explanation":string}]}'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({ candidates })
      }
    ]
  })

  const raw = response.choices[0]?.message?.content
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
    return { wikiIds: [] as string[], scrapIds: [] as string[], matchedNodeIds: [] as string[] }
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

  return {
    wikiIds: [...wikiIds].slice(0, 6),
    scrapIds: [...scrapIds].slice(0, 8),
    matchedNodeIds: [...matchedNodeIds].slice(0, 16)
  }
}
