'use client'

import { useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Background,
  Controls,
  Position,
  ReactFlow,
  type Edge,
  type Node
} from '@xyflow/react'
import type { GraphifyNode as GraphNode, GraphifyPayload } from '@/lib/types'

type GraphifyViewProps = {
  payload: GraphifyPayload | null
  onOpenNode: (node: GraphNode) => void
}

const kindLabel: Record<GraphNode['kind'], string> = {
  scrap: 'Scrap',
  wiki: 'Wiki',
  claim: 'Claim',
  concept: 'Concept'
}

function kindOrder(kind: GraphNode['kind']) {
  switch (kind) {
    case 'wiki':
      return 0
    case 'concept':
      return 1
    case 'claim':
      return 2
    case 'scrap':
      return 3
  }
}

function shortLabel(label: string, max = 52) {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`
}

function normalizedTokens(label: string) {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace('#', '')
  const safe = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized
  const value = Number.parseInt(safe, 16)
  const red = (value >> 16) & 255
  const green = (value >> 8) & 255
  const blue = value & 255
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function estimatedNodeRadius(node: GraphNode) {
  const base = node.kind === 'wiki'
    ? 78
    : node.kind === 'scrap'
      ? 64
      : node.kind === 'claim'
        ? 56
        : 52
  return Math.min(168, base + node.label.length * 1.25)
}

function estimatedLabelBox(node: GraphNode) {
  const width = Math.min(
    node.kind === 'wiki' ? 232 : node.kind === 'scrap' ? 188 : 150,
    60 + node.label.length * (node.kind === 'wiki' ? 3.85 : node.kind === 'scrap' ? 3.1 : 2.95)
  )
  const height = node.kind === 'wiki' ? 36 : 31
  return { width, height }
}

function resolveNodeHandlePositions(
  nodeId: string,
  positions: Map<string, { x: number; y: number }>,
  edges: Array<{ source: string; target: string }>
) {
  const current = positions.get(nodeId)
  if (!current) {
    return {
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top
    }
  }

  const neighborYs = edges
    .flatMap((edge) => {
      if (edge.source === nodeId) return [positions.get(edge.target)?.y]
      if (edge.target === nodeId) return [positions.get(edge.source)?.y]
      return []
    })
    .filter((value): value is number => typeof value === 'number')

  if (neighborYs.length === 0) {
    return {
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top
    }
  }

  const averageNeighborY = neighborYs.reduce((sum, value) => sum + value, 0) / neighborYs.length
  const neighborsMostlyAbove = averageNeighborY < current.y

  return {
    sourcePosition: neighborsMostlyAbove ? Position.Top : Position.Bottom,
    targetPosition: neighborsMostlyAbove ? Position.Bottom : Position.Top
  }
}

function clusterCenters(
  clusters: Array<GraphifyPayload['clusters'][number] & { nodes: GraphNode[] }>,
  edges: GraphifyPayload['edges']
) {
  if (clusters.length === 0) return new Map<string, { x: number; y: number }>()

  const centers = new Map<string, { x: number; y: number }>()

  const ordered = [...clusters].sort((left, right) => right.nodes.length - left.nodes.length)
  const baseRadius = Math.max(620, 420 + ordered.length * 56)
  ordered.forEach((cluster, index) => {
    if (index === 0) {
      centers.set(cluster.id, { x: 0, y: 0 })
      return
    }
    const angle = (-Math.PI / 2) + (index / Math.max(1, ordered.length - 1)) * Math.PI * 2
    centers.set(cluster.id, {
      x: Math.cos(angle) * baseRadius,
      y: Math.sin(angle) * baseRadius * 0.72
    })
  })

  const clusterNodeMap = new Map(ordered.map((cluster) => [cluster.id, cluster.nodes]))
  const labelTokens = new Map<string, Set<string>>()
  ordered.forEach((cluster) => {
    const bag = new Set<string>()
    normalizedTokens(cluster.label).forEach((token) => bag.add(token))
    cluster.nodes.slice(0, 8).forEach((node) => {
      normalizedTokens(node.label).forEach((token) => bag.add(token))
    })
    labelTokens.set(cluster.id, bag)
  })

  const clusterLinks = new Map<string, Array<{ id: string; weight: number }>>()
  ordered.forEach((cluster) => clusterLinks.set(cluster.id, []))
  edges.forEach((edge) => {
    const sourceCluster = ordered.find((cluster) => cluster.nodes.some((node) => node.id === edge.source))?.id
    const targetCluster = ordered.find((cluster) => cluster.nodes.some((node) => node.id === edge.target))?.id
    if (!sourceCluster || !targetCluster || sourceCluster === targetCluster) return
    clusterLinks.get(sourceCluster)?.push({ id: targetCluster, weight: edge.weight })
    clusterLinks.get(targetCluster)?.push({ id: sourceCluster, weight: edge.weight })
  })

  for (let iteration = 0; iteration < 120; iteration += 1) {
    const cooling = 1 - iteration / 120
    const deltas = new Map<string, { x: number; y: number }>()
    ordered.forEach((cluster) => deltas.set(cluster.id, { x: 0, y: 0 }))

    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const left = ordered[i]
        const right = ordered[j]
        const leftPos = centers.get(left.id)!
        const rightPos = centers.get(right.id)!
        const dx = leftPos.x - rightPos.x
        const dy = leftPos.y - rightPos.y
        const distance = Math.max(120, Math.hypot(dx, dy))
        const leftTokens = labelTokens.get(left.id) ?? new Set<string>()
        const rightTokens = labelTokens.get(right.id) ?? new Set<string>()
        const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length
        const repulsion = (overlap > 0 ? 180000 : 240000) / (distance * distance)
        const ux = dx / distance
        const uy = dy / distance
        const leftDelta = deltas.get(left.id)!
        const rightDelta = deltas.get(right.id)!
        leftDelta.x += clamp(ux * repulsion, -24, 24)
        leftDelta.y += clamp(uy * repulsion, -24, 24)
        rightDelta.x -= clamp(ux * repulsion, -24, 24)
        rightDelta.y -= clamp(uy * repulsion, -24, 24)
      }
    }

    ordered.forEach((cluster) => {
      const delta = deltas.get(cluster.id)!
      const current = centers.get(cluster.id)!
      const links = clusterLinks.get(cluster.id) ?? []
      const totalLinked = links.length
      const tokenBag = labelTokens.get(cluster.id) ?? new Set<string>()

      ordered.forEach((other) => {
        if (other.id === cluster.id) return
        const shared = [...tokenBag].filter((token) => (labelTokens.get(other.id) ?? new Set<string>()).has(token)).length
        if (shared === 0) return
        const otherPos = centers.get(other.id)!
        const dx = otherPos.x - current.x
        const dy = otherPos.y - current.y
        const distance = Math.max(120, Math.hypot(dx, dy))
        const targetDistance = Math.max(340, 620 - shared * 36)
        const spring = (distance - targetDistance) * 0.0028
        delta.x += clamp((dx / distance) * spring, -12, 12)
        delta.y += clamp((dy / distance) * spring, -12, 12)
      })

      links.forEach((link) => {
        const otherPos = centers.get(link.id)
        if (!otherPos) return
        const dx = otherPos.x - current.x
        const dy = otherPos.y - current.y
        const distance = Math.max(120, Math.hypot(dx, dy))
        const targetDistance = Math.max(300, 560 - link.weight * 28)
        const spring = (distance - targetDistance) * 0.0032
        delta.x += clamp((dx / distance) * spring, -14, 14)
        delta.y += clamp((dy / distance) * spring, -14, 14)
      })

      if (cluster.id !== ordered[0]?.id) {
        const orbit = Math.max(360, baseRadius - Math.min(180, totalLinked * 14))
        const distance = Math.max(1, Math.hypot(current.x, current.y))
        const correction = (distance - orbit) * 0.0018
        delta.x -= clamp((current.x / distance) * correction, -10, 10)
        delta.y -= clamp((current.y / distance) * correction, -10, 10)
      }
    })

    ordered.forEach((cluster) => {
      const current = centers.get(cluster.id)!
      const delta = deltas.get(cluster.id)!
      current.x = clamp(current.x + clamp(delta.x * 20 * cooling, -60, 60), -2200, 2200)
      current.y = clamp(current.y + clamp(delta.y * 20 * cooling, -60, 60), -1800, 1800)
    })
  }

  return centers
}

function seedNodePosition(
  node: GraphNode,
  index: number,
  clusterIndex: number,
  clusterSize: number,
  center: { x: number; y: number }
) {
  const baseRadius = estimatedNodeRadius(node)
  const angle = ((index / Math.max(1, clusterSize)) * Math.PI * 2) + clusterIndex * 0.41
  const spiral = Math.ceil(index / 4)
  const radius = spiral * (54 + baseRadius * 0.58)
  const jitter = ((index % 7) - 3) * 4
  return {
    x: center.x + Math.cos(angle) * radius + jitter,
    y: center.y + Math.sin(angle) * radius * 0.84 + jitter * 0.42
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(min, Math.min(max, value))
}

function runForceLayout(
  nodes: Array<GraphNode & { x: number; y: number }>,
  edges: GraphifyPayload['edges'],
  centers: Map<string, { x: number; y: number }>
) {
  const positions = new Map<string, { x: number; y: number }>()
  nodes.forEach((node) => positions.set(node.id, { x: node.x, y: node.y }))
  const radii = new Map(nodes.map((node) => [node.id, estimatedNodeRadius(node)]))

  const adjacency = new Map<string, Array<{ id: string; weight: number; sameCluster: boolean }>>()
  nodes.forEach((node) => adjacency.set(node.id, []))
  edges.forEach((edge) => {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (!source || !target) return
    const sameCluster = source.clusterId === target.clusterId
    adjacency.get(edge.source)?.push({ id: edge.target, weight: edge.weight, sameCluster })
    adjacency.get(edge.target)?.push({ id: edge.source, weight: edge.weight, sameCluster })
  })

  const iterations = 120
  const bounds = 2800
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - (iteration / iterations)
    const deltas = new Map<string, { x: number; y: number }>()
    nodes.forEach((node) => deltas.set(node.id, { x: 0, y: 0 }))

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const left = nodes[i]
        const right = nodes[j]
        const leftPos = positions.get(left.id)!
        const rightPos = positions.get(right.id)!
        const dx = leftPos.x - rightPos.x
        const dy = leftPos.y - rightPos.y
        const minDistance = Math.max(48, (radii.get(left.id) ?? 60) + (radii.get(right.id) ?? 60) + 18)
        const distance = Math.max(minDistance, Math.hypot(dx, dy))
        const repulsionBase = left.clusterId === right.clusterId ? 92000 : 18000
        const repulsion = repulsionBase / (distance * distance)
        const ux = dx / distance
        const uy = dy / distance
        const leftDelta = deltas.get(left.id)!
        const rightDelta = deltas.get(right.id)!
        leftDelta.x += clamp(ux * repulsion, -22, 22)
        leftDelta.y += clamp(uy * repulsion, -22, 22)
        rightDelta.x -= clamp(ux * repulsion, -22, 22)
        rightDelta.y -= clamp(uy * repulsion, -22, 22)
      }
    }

    nodes.forEach((node) => {
      const pos = positions.get(node.id)!
      const delta = deltas.get(node.id)!
      const neighbors = adjacency.get(node.id) ?? []
      neighbors.forEach((neighbor) => {
        const otherPos = positions.get(neighbor.id)
        if (!otherPos) return
        const dx = otherPos.x - pos.x
        const dy = otherPos.y - pos.y
        const nodeRadius = radii.get(node.id) ?? 60
        const otherRadius = radii.get(neighbor.id) ?? 60
        const distance = Math.max(24, Math.hypot(dx, dy))
        const baseTarget = neighbor.sameCluster ? nodeRadius + otherRadius + 92 : nodeRadius + otherRadius + 144
        const targetDistance = Math.min(420, baseTarget + (neighbor.sameCluster ? 0 : 40))
        const spring = ((distance - targetDistance) * 0.0048) * Math.max(0.8, neighbor.weight)
        delta.x += clamp((dx / distance) * spring, -12, 12)
        delta.y += clamp((dy / distance) * spring, -12, 12)
      })

      const center = centers.get(node.clusterId ?? '')
      if (center) {
        const dx = center.x - pos.x
        const dy = center.y - pos.y
        delta.x += clamp(dx * 0.0005, -3, 3)
        delta.y += clamp(dy * 0.0005, -3, 3)
      }
    })

    nodes.forEach((node) => {
      const pos = positions.get(node.id)!
      const delta = deltas.get(node.id)!
      pos.x = clamp(pos.x + clamp(delta.x * 18 * cooling, -64, 64), -bounds, bounds)
      pos.y = clamp(pos.y + clamp(delta.y * 18 * cooling, -64, 64), -bounds, bounds)
    })
  }

  return positions
}

function relaxLabelCollisions(
  nodes: Array<GraphNode & { x: number; y: number }>,
  positions: Map<string, { x: number; y: number }>
) {
  const iterations = 140
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - iteration / iterations
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const left = nodes[i]
        const right = nodes[j]
        const leftPos = positions.get(left.id)!
        const rightPos = positions.get(right.id)!
        const leftBox = estimatedLabelBox(left)
        const rightBox = estimatedLabelBox(right)
        const dx = leftPos.x - rightPos.x
        const dy = leftPos.y - rightPos.y
        const overlapX = (leftBox.width + rightBox.width) / 2 - Math.abs(dx)
        const overlapY = (leftBox.height + rightBox.height) / 2 - Math.abs(dy)
        if (overlapX <= 0 || overlapY <= 0) continue
        const push = Math.min(32, Math.max(overlapX, overlapY) * 0.21) * cooling
        const distance = Math.max(1, Math.hypot(dx, dy))
        const ux = dx / distance
        const uy = dy / distance
        const sameCluster = left.clusterId === right.clusterId
        const factor = sameCluster ? 1.55 : 1.05
        leftPos.x += ux * push * factor
        leftPos.y += uy * push * factor
        rightPos.x -= ux * push * factor
        rightPos.y -= uy * push * factor
      }
    }
  }
  return positions
}

function makeLayout(payload: GraphifyPayload, clusterFilter: string, kindFilter: Set<GraphNode['kind']>) {
  const allowedNodes = payload.nodes.filter((node) => {
    if (clusterFilter !== 'all' && node.clusterId !== clusterFilter) return false
    return kindFilter.has(node.kind)
  })
  const allowedIds = new Set(allowedNodes.map((node) => node.id))
  const edges = payload.edges.filter((edge) => allowedIds.has(edge.source) && allowedIds.has(edge.target))

  const clusters = payload.clusters
    .filter((cluster) => clusterFilter === 'all' || cluster.id === clusterFilter)
    .map((cluster) => ({
      ...cluster,
      nodes: allowedNodes
        .filter((node) => node.clusterId === cluster.id)
        .sort((left, right) => {
          const kindDelta = kindOrder(left.kind) - kindOrder(right.kind)
          if (kindDelta !== 0) return kindDelta
          return right.degree - left.degree
        })
    }))
    .filter((cluster) => cluster.nodes.length > 0)
    .sort((left, right) => right.nodes.length - left.nodes.length)

  const centers = clusterCenters(clusters, edges)
  const seedNodes: Array<GraphNode & { x: number; y: number }> = []

  clusters.forEach((cluster, clusterIndex) => {
    const center = centers.get(cluster.id) ?? { x: 0, y: 0 }

    cluster.nodes.forEach((node, index) => {
      const position = seedNodePosition(node, index, clusterIndex, cluster.nodes.length, center)
      seedNodes.push({
        ...node,
        x: position.x,
        y: position.y
      })
    })
  })

  const forcePositions = relaxLabelCollisions(seedNodes, runForceLayout(seedNodes, edges, centers))

  const layoutNodes: Node[] = seedNodes.map((node) => {
    const cluster = payload.clusters.find((item) => item.id === node.clusterId)
    const handles = resolveNodeHandlePositions(node.id, forcePositions, edges)
    return {
      id: node.id,
      position: forcePositions.get(node.id) ?? { x: node.x, y: node.y },
      sourcePosition: handles.sourcePosition,
      targetPosition: handles.targetPosition,
      data: {
        label: (
          <button
            className={clsx('graph-node-card', `graph-node-${node.kind}`)}
            type='button'
            title={node.label}
            style={{
              ['--cluster-color' as string]: cluster?.color ?? '#6b7288',
              ['--cluster-soft' as string]: hexToRgba(cluster?.color ?? '#6b7288', 0.12),
              ['--cluster-border' as string]: hexToRgba(cluster?.color ?? '#6b7288', 0.28)
            }}
          >
            <span className='graph-node-dot' />
            <span className='graph-node-text'>
              {shortLabel(node.label, node.kind === 'wiki' ? 60 : node.kind === 'scrap' ? 44 : 34)}
            </span>
          </button>
        )
      },
      selectable: false,
      draggable: false,
      style: {
        width: 'auto',
        maxWidth: node.kind === 'wiki' ? 232 : node.kind === 'scrap' ? 188 : 150,
        background: 'transparent',
        border: 'none',
        padding: 0
      }
    }
  })

  const normalLayoutEdges: Edge[] = []
  const surprisingLayoutEdges: Edge[] = []
  let surprisingOrdinal = 0

  edges.forEach((edge) => {
    const sourceNode = allowedNodes.find((node) => node.id === edge.source)
    const targetNode = allowedNodes.find((node) => node.id === edge.target)
    const sameCluster = sourceNode?.clusterId && sourceNode.clusterId === targetNode?.clusterId
    const surprising = Boolean(edge.surprising)

    const baseStroke = sameCluster
      ? edge.provenance === 'INFERRED'
        ? 'rgba(126, 136, 146, 0.18)'
        : 'rgba(104, 112, 120, 0.14)'
      : edge.provenance === 'INFERRED'
        ? 'rgba(90, 98, 104, 0.12)'
        : 'rgba(76, 82, 88, 0.08)'

    const baseEdge: Edge = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'default',
      animated: false,
      zIndex: surprising ? 1 : 0,
      className: 'graph-edge graph-edge-muted',
      style: {
        stroke: baseStroke,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        pointerEvents: 'none',
        strokeDasharray: edge.provenance === 'INFERRED'
          ? '3 8'
          : edge.provenance === 'AMBIGUOUS'
            ? '1 10'
            : undefined,
        opacity: edge.provenance === 'AMBIGUOUS'
          ? 0.08
          : edge.provenance === 'INFERRED'
            ? 0.18
            : 0.24,
        strokeWidth: Math.max(0.7, Math.min(1.3, 0.64 + edge.weight * 0.12))
      },
      interactionWidth: 0
    }

    normalLayoutEdges.push(baseEdge)

    if (surprising) {
      surprisingOrdinal += 1
      const surprisingScore = edge.surprisingScore ?? edge.weight
      surprisingLayoutEdges.push({
        id: `${edge.id}__surprising_glow`,
        source: edge.source,
        target: edge.target,
        type: 'default',
        animated: false,
        zIndex: 20,
        className: 'graph-edge graph-edge-surprising graph-edge-surprising-glow',
        style: {
          stroke: 'rgba(220, 96, 96, 0.24)',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          pointerEvents: 'none',
          opacity: 0.92,
          strokeWidth: Math.max(8.4, Math.min(11.6, 7.2 + surprisingScore * 0.62))
        },
        interactionWidth: 0
      })
      surprisingLayoutEdges.push({
        id: `${edge.id}__surprising_core`,
        source: edge.source,
        target: edge.target,
        type: 'default',
        animated: false,
        zIndex: 21,
        className: 'graph-edge graph-edge-surprising graph-edge-surprising-core',
        style: {
          stroke: sameCluster ? 'rgba(176, 46, 46, 0.98)' : 'rgba(198, 56, 56, 0.96)',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          pointerEvents: 'none',
          opacity: 0.98,
          strokeWidth: Math.max(3.2, Math.min(5.2, 2.6 + surprisingScore * 0.4))
        },
        interactionWidth: 0
      })
    }
  })

  const layoutEdges: Edge[] = [...normalLayoutEdges, ...surprisingLayoutEdges]

  return { nodes: layoutNodes, edges: layoutEdges, clusters }
}

export default function GraphifyView({ payload, onOpenNode }: GraphifyViewProps) {
  const [clusterFilter, setClusterFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState<Set<GraphNode['kind']>>(new Set(['scrap', 'wiki', 'claim', 'concept']))

  const safePayload = useMemo(() => (
    payload ?? {
      nodes: [],
      edges: [],
      clusters: [],
      godNodes: [],
      surprisingConnections: [],
      generatedAt: null,
      stale: true
    }
  ), [payload])

  const layout = useMemo(
    () => makeLayout(safePayload, clusterFilter, kindFilter),
    [safePayload, clusterFilter, kindFilter]
  )

  return (
    <div className='graph-shell graph-shell-light'>
      <div className='graph-summary graph-summary-light'>
        <div className='toolbar-row graph-toolbar graph-toolbar-light'>
          <select className='select graph-filter' value={clusterFilter} onChange={(event) => setClusterFilter(event.target.value)}>
            <option value='all'>All clusters</option>
            {safePayload.clusters.map((cluster) => (
              <option key={cluster.id} value={cluster.id}>
                {cluster.label}
              </option>
            ))}
          </select>
          <div className='chip-row'>
            {(['wiki', 'scrap', 'claim', 'concept'] as const).map((kind) => {
              const active = kindFilter.has(kind)
              return (
                <button
                  key={kind}
                  className={clsx('chip', active && 'active')}
                  type='button'
                  onClick={() => {
                    setKindFilter((current) => {
                      const next = new Set(current)
                      if (next.has(kind)) {
                        if (next.size === 1) return current
                        next.delete(kind)
                      } else {
                        next.add(kind)
                      }
                      return next
                    })
                  }}
                >
                  {kindLabel[kind]}
                </button>
              )
            })}
          </div>
        </div>

        {safePayload.clusters.length > 0 ? (
          <div className='graph-cluster-legend graph-cluster-legend-compact'>
            {safePayload.clusters.slice(0, 6).map((cluster) => (
              <button
                key={cluster.id}
                className={clsx('graph-cluster-pill', clusterFilter === cluster.id && 'active')}
                type='button'
                onClick={() => setClusterFilter((current) => current === cluster.id ? 'all' : cluster.id)}
                style={{
                  ['--cluster-color' as string]: cluster.color,
                  ['--cluster-soft' as string]: hexToRgba(cluster.color, 0.14),
                  ['--cluster-border' as string]: hexToRgba(cluster.color, 0.4)
                }}
                title={cluster.label}
              >
                <span className='graph-cluster-pill-dot' />
                <span>{shortLabel(cluster.label, 18)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {safePayload.nodes.length === 0 ? (
        <div className='empty graph-empty'>
          그래프 캐시가 없습니다. 상단의 그래프 갱신 버튼으로 한 번 생성해 주세요.
        </div>
      ) : (
        <div className='graph-canvas graph-canvas-light'>
          <ReactFlow
            nodes={layout.nodes}
            edges={layout.edges}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            onNodeClick={(_, node) => {
              const target = safePayload.nodes.find((item) => item.id === node.id)
              if (target) onOpenNode(target)
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} color='rgba(17, 17, 17, 0.04)' />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </div>
  )
}
