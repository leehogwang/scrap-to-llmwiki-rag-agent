export type CaptureType = 'dom' | 'dom+images' | 'ocr' | 'mixed'

export type UploadStatus = 'uploaded' | 'skipped' | 'failed'

export type WikiDraftStatus = 'draft' | 'approved' | 'published'

export interface SelectionRect {
  left: number
  top: number
  width: number
  height: number
  scrollX?: number
  scrollY?: number
  devicePixelRatio?: number
}

export interface ScrapCandidateChunk {
  id: string
  text: string
  nearestHeading: string
  positionIndex: number
  intersectsSelection: boolean
  domPath: string
  containerPath: string
  top?: number
  bottom?: number
}

export interface ScrapChunk extends ScrapCandidateChunk {
  score?: number
  reason?: string
}

export interface ScrapImageCandidate {
  id: string
  sourceUrl: string
  nearestHeading: string
  positionIndex: number
  intersectsSelection: boolean
  top: number
  bottom: number
  width: number
  height: number
}

export interface YouTubeCaptureMeta {
  mode: 'watch_video' | 'thumbnail_card'
  videoId: string
  videoUrl: string
  videoTitle: string
  channelName?: string
  channelUrl?: string
  thumbnailUrl?: string
  referrerUrl?: string
}

export interface ScrapAsset {
  id: string
  filename: string
  mimeType: string
  sourceUrl: string | null
  notionFileId: string | null
  status: UploadStatus
  sizeBytes: number
  width?: number
  height?: number
  caption?: string
  error?: string
}

export interface Scrap {
  id: string
  notionPageId: string | null
  title: string
  pageTitle: string
  sourceUrl: string
  sourceHost: string
  selectedText: string
  anchorChunks: ScrapChunk[]
  contextChunks: ScrapChunk[]
  semanticChunks: ScrapChunk[]
  selectionRect: SelectionRect | null
  ocrText: string
  mergedText: string
  captureType: CaptureType
  userNote: string
  tags: string[]
  images: ScrapAsset[]
  screenshot: ScrapAsset | null
  metadata: Record<string, unknown>
  capturedAt: string
  createdAt: string
  updatedAt: string
}

export interface ScrapSummary {
  id: string
  title: string
  sourceHost: string
  sourceUrl: string
  captureType: CaptureType
  summary: string
  tags: string[]
  imageCount: number
  semanticChunkCount: number
  capturedAt: string
}

export interface WikiSection {
  heading: string
  paragraphs: string[]
  bullets: string[]
}

export interface WikiClaim {
  claim: string
  evidence: string[]
  supportLevel: 'supported' | 'weak' | 'conflicting' | 'open'
  relatedScrapIds: string[]
}

export interface WikiDraft {
  id: string
  notionPageId: string | null
  title: string
  topic: string
  mode: 'general' | 'claim_compare' | 'study_notes' | 'decision_log' | 'onboarding_map'
  status: WikiDraftStatus
  summary: string
  keyConcepts: string[]
  claims: WikiClaim[]
  openQuestions: string[]
  sections: WikiSection[]
  scrapIds: string[]
  sourceLinks: Array<{ scrapId: string; title: string; url: string }>
  createdAt: string
  updatedAt: string
  generationAction?: 'created' | 'updated'
}

export interface WikiDraftSummary {
  id: string
  title: string
  topic: string
  mode: WikiDraft['mode']
  status: WikiDraftStatus
  summary: string
  scrapCount: number
  updatedAt: string
}

export interface WikiGenerationResponse {
  blocked: boolean
  message: string
  draft?: WikiDraft
  drafts?: WikiDraft[]
  graphPayload?: GraphifyPayload
}

export type GraphifyNodeKind = 'scrap' | 'wiki' | 'claim' | 'concept'
export type GraphifyProvenance = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'
export type GraphifyEdgeRelation =
  | 'summarizes'
  | 'derived_from'
  | 'contains_claim'
  | 'contains_concept'
  | 'mentions_concept'
  | 'related_to'
  | 'supports'
  | 'conflicts_with'
  | 'about'

export interface GraphifyNode {
  id: string
  kind: GraphifyNodeKind
  label: string
  refId: string | null
  provenance: GraphifyProvenance
  confidence: number
  degree: number
  clusterId: string | null
  summary?: string
  metadata?: Record<string, unknown>
}

export interface GraphifyEdge {
  id: string
  source: string
  target: string
  relation: GraphifyEdgeRelation
  provenance: GraphifyProvenance
  confidence: number
  weight: number
  explanation?: string
  surprising?: boolean
  surprisingScore?: number
}

export interface GraphifyCluster {
  id: string
  label: string
  color: string
  nodeIds: string[]
}

export interface GraphifyGodNode {
  nodeId: string
  label: string
  degree: number
  kind: GraphifyNodeKind
}

export interface GraphifySurprisingConnection {
  edgeId: string
  sourceId: string
  sourceLabel: string
  targetId: string
  targetLabel: string
  relation: GraphifyEdgeRelation
  confidence: number
  explanation?: string
}

export interface GraphifyPayload {
  nodes: GraphifyNode[]
  edges: GraphifyEdge[]
  clusters: GraphifyCluster[]
  godNodes: GraphifyGodNode[]
  surprisingConnections: GraphifySurprisingConnection[]
  generatedAt: string | null
  stale: boolean
}

export interface GraphifyNodeDetail {
  node: GraphifyNode
  neighbors: Array<{
    edge: GraphifyEdge
    node: GraphifyNode
  }>
}

export interface GraphifyEdgeDetail {
  edge: GraphifyEdge
  sourceNode: GraphifyNode
  targetNode: GraphifyNode
  surprisingConnection?: GraphifySurprisingConnection
}

export interface ChatRequestBody {
  prompt: string
  selectedScrapIds?: string[]
}

export interface ExtensionCapturePayload {
  pageUrl: string
  pageTitle: string
  sourceHost: string
  selectedText: string
  candidateChunks: ScrapCandidateChunk[]
  imageUrls: string[]
  imageCandidates?: ScrapImageCandidate[]
  youtubeMeta?: YouTubeCaptureMeta
  userNote?: string
  tags?: string[]
  rect?: SelectionRect
}
