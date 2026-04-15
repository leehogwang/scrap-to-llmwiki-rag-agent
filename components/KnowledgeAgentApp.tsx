'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import dynamic from 'next/dynamic'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  ChatRequestBody,
  GraphifyEdgeDetail,
  GraphifyNode,
  GraphifyNodeDetail,
  GraphifyPayload,
  Scrap,
  ScrapSummary,
  WikiDraft,
  WikiDraftSummary,
  WikiGenerationResponse
} from '@/lib/types'

const GraphifyView = dynamic(() => import('@/components/GraphifyView'), {
  ssr: false,
  loading: () => <div className='empty graph-empty'>Graphify 캔버스를 불러오는 중입니다.</div>
})

type ChatMessage = {
  role: 'user' | 'agent' | 'system'
  text: string
}

function normalizeUiError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback
  const message = error.message.trim()
  if (!message) return fallback
  if (
    message.startsWith('[') ||
    message.startsWith('{') ||
    message.includes('위키 초안 요청 형식이 올바르지 않습니다') ||
    message.includes('스크랩을 다시 선택한 뒤 시도해 주세요') ||
    message.includes('String must contain at least') ||
    message.includes('String must contain at most') ||
    message.includes('too_small') ||
    message.includes('too_big') ||
    message.includes('ZodError')
  ) {
    return fallback
  }
  return message
}

function extractGeneratedDrafts(payload: WikiGenerationResponse) {
  if (Array.isArray(payload.drafts) && payload.drafts.length > 0) {
    return payload.drafts
  }
  if (payload.draft) {
    return [payload.draft]
  }
  return []
}

function buildWikiGenerationMessage(payload: WikiGenerationResponse, drafts: WikiDraft[]) {
  const message = payload.message.trim()
  if (message) return message
  const createdCount = drafts.filter((draft) => draft.generationAction === 'created').length
  const updatedCount = drafts.filter((draft) => draft.generationAction === 'updated').length
  if (drafts.length === 1) {
    return drafts[0].generationAction === 'updated'
      ? `기존 위키 "${drafts[0].title}"를 업데이트했습니다.`
      : `위키 초안 "${drafts[0].title}"를 생성했습니다.`
  }
  if (drafts.length > 1) {
    const titles = drafts.slice(0, 3).map((draft) => draft.title).filter(Boolean)
    const actionSummary = [
      createdCount > 0 ? `새 생성 ${createdCount}개` : '',
      updatedCount > 0 ? `기존 업데이트 ${updatedCount}개` : ''
    ].filter(Boolean).join(' · ')
    return titles.length > 0
      ? `${drafts.length}개의 위키 초안을 처리했습니다.${actionSummary ? ` (${actionSummary})` : ''} 생성된 초안: ${titles.join(', ')}`
      : `${drafts.length}개의 위키 초안을 처리했습니다.${actionSummary ? ` (${actionSummary})` : ''}`
  }
  return '위키 초안을 생성했습니다.'
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  const text = await response.text()
  if (!text.trim()) return null
  return JSON.parse(text) as T
}

async function parseNdjsonStream(
  response: Response,
  handlers: {
    onProgress?: (payload: { completed: number; total: number; title?: string }) => void
    onResult?: (payload: WikiGenerationResponse) => Promise<void> | void
    onError?: (message: string) => void
  }
) {
  if (!response.body) {
    throw new Error('응답 본문이 없습니다.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')

      if (!line) continue
      const entry = JSON.parse(line) as
        | ({ type: 'progress' } & { completed: number; total: number; title?: string })
        | { type: 'result'; payload: WikiGenerationResponse }
        | { type: 'error'; message: string }

      if (entry.type === 'progress') {
        handlers.onProgress?.({ completed: entry.completed, total: entry.total, title: entry.title })
      } else if (entry.type === 'result') {
        await handlers.onResult?.(entry.payload)
      } else if (entry.type === 'error') {
        handlers.onError?.(entry.message)
      }
    }
  }
}

type WorkspaceTab = 'scraps' | 'wiki' | 'graphify'
const scrapsPerPage = 10
const wikiPerPage = 10
type DetailState =
  | { type: 'scrap'; item: Scrap }
  | { type: 'wiki'; item: WikiDraft }
  | { type: 'graph'; item: GraphifyNodeDetail }
  | { type: 'graph-edge'; item: GraphifyEdgeDetail }
  | null

export default function KnowledgeAgentApp() {
  const [tab, setTab] = useState<WorkspaceTab>('scraps')
  const [scraps, setScraps] = useState<ScrapSummary[]>([])
  const [wikiDrafts, setWikiDrafts] = useState<WikiDraftSummary[]>([])
  const [graphify, setGraphify] = useState<GraphifyPayload | null>(null)
  const [selectedScrapIds, setSelectedScrapIds] = useState<string[]>([])
  const [selectedWikiIds, setSelectedWikiIds] = useState<string[]>([])
  const [detail, setDetail] = useState<DetailState>(null)
  const [scrapQuery, setScrapQuery] = useState('')
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [graphLoading, setGraphLoading] = useState(false)
  const [wikiProgress, setWikiProgress] = useState<{ completed: number; total: number; title?: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [currentScrapPage, setCurrentScrapPage] = useState(1)
  const [currentWikiPage, setCurrentWikiPage] = useState(1)
  const [autoApproveWiki, setAutoApproveWiki] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'system',
      text: 'ClipWiki는 브라우저 스크랩을 Notion에 저장하고, 누적된 스크랩을 바탕으로 LLM-Wiki 초안을 만드는 학습 보조 에이전트입니다.'
    }
  ])
  const [savingChatIndexes, setSavingChatIndexes] = useState<number[]>([])
  const [savedChatIndexes, setSavedChatIndexes] = useState<number[]>([])
  const chatLogRef = useRef<HTMLDivElement | null>(null)
  const automationBootedRef = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    setAutoApproveWiki(window.localStorage.getItem('clipwiki:auto-approve-wiki') === 'true')
    setSettingsLoaded(true)
  }, [])

  useEffect(() => {
    if (!settingsLoaded || typeof window === 'undefined') return
    window.localStorage.setItem('clipwiki:auto-approve-wiki', autoApproveWiki ? 'true' : 'false')
  }, [autoApproveWiki, settingsLoaded])

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return
    if (event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    void handleChat()
  }

  useEffect(() => {
    const node = chatLogRef.current
    if (!node) return
    // Keep the latest reply visible because chat answers and automation progress arrive asynchronously.
    node.scrollTo({
      top: node.scrollHeight,
      behavior: 'smooth'
    })
  }, [messages, loading])

  const refresh = useCallback(async (query = scrapQuery) => {
    setRefreshing(true)
    try {
      const queryParam = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ''
      // Refresh all three data views together so scraps, drafts, and the graph never drift out of sync in the UI.
      const [scrapResponse, wikiResponse, graphResponse] = await Promise.all([
        fetch(`/api/scraps${queryParam}`).then((res) => res.json()) as Promise<{ scraps: ScrapSummary[] }>,
        fetch('/api/wiki/drafts').then((res) => res.json()) as Promise<{ drafts: WikiDraftSummary[] }>,
        fetch('/api/graphify').then((res) => res.json()) as Promise<GraphifyPayload>
      ])
      setScraps(scrapResponse.scraps)
      setWikiDrafts(wikiResponse.drafts)
      setGraphify(graphResponse)
      setLastUpdatedAt(new Date().toLocaleTimeString())
    } finally {
      setRefreshing(false)
    }
  }, [scrapQuery])

  useEffect(() => {
    void refresh('')
  }, [refresh])

  useEffect(() => {
    setCurrentScrapPage(1)
  }, [scrapQuery, scraps.length])

  useEffect(() => {
    setCurrentWikiPage(1)
  }, [wikiDrafts.length])

  const runDailyAutomation = useCallback(async (options: { forceGraph?: boolean; forceWiki?: boolean; appendMessage?: boolean } = {}) => {
    const appendMessage = options.appendMessage ?? true
    if (options.forceGraph) setGraphLoading(true)
    try {
      const response = await fetch('/api/automation/daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          forceGraph: options.forceGraph ?? false,
          forceWiki: options.forceWiki ?? false,
          autoApprove: autoApproveWiki
        })
      })
      const payload = await parseJsonResponse<{
        error?: string
        graphPayload?: GraphifyPayload
        graphRebuilt?: boolean
        wikiGenerated?: boolean
        wikiDraftCount?: number
        drafts?: WikiDraft[]
        autoApproved?: boolean
      }>(response)
      if (!response.ok) {
        throw new Error(payload?.error ?? '자동 계산에 실패했습니다.')
      }

      if (payload?.graphPayload) {
        setGraphify(payload.graphPayload)
      }

      if (payload?.graphRebuilt || payload?.wikiGenerated) {
        await refresh(scrapQuery)
      }

      if (appendMessage) {
        const parts = [
          payload?.graphRebuilt ? '그래프를 갱신했습니다.' : '',
          payload?.wikiGenerated
            ? `${payload.autoApproved ? '위키 자동 승인 및 게시를 포함해' : '위키 초안'} ${payload.wikiDraftCount ?? 0}개를 처리했습니다.`
            : ''
        ].filter(Boolean)
        if (parts.length > 0) {
          setMessages((current) => [...current, { role: 'system', text: parts.join(' ') }])
        }
      }
    } catch (error) {
      if (appendMessage) {
        setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '자동 계산에 실패했습니다.') }])
      }
    } finally {
      if (options.forceGraph) setGraphLoading(false)
    }
  }, [autoApproveWiki, bulkApproveDrafts, refresh, scrapQuery])

  const runManualGraphRebuild = useCallback(async () => {
    setGraphLoading(true)
    try {
      const response = await fetch('/api/graphify/rebuild', {
        method: 'POST'
      })
      const payload = await parseJsonResponse<GraphifyPayload & { error?: string }>(response)
      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? '그래프 갱신에 실패했습니다.')
      }
      setGraphify(payload)
      await refresh(scrapQuery)
      setMessages((current) => [...current, { role: 'system', text: '그래프를 갱신했습니다.' }])
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '그래프 갱신에 실패했습니다.') }])
    } finally {
      setGraphLoading(false)
    }
  }, [refresh, scrapQuery])

  useEffect(() => {
    if (!settingsLoaded) return
    if (automationBootedRef.current) return
    automationBootedRef.current = true
    void runDailyAutomation({ appendMessage: true })
  }, [runDailyAutomation, settingsLoaded])

  async function openScrap(id: string) {
    const response = await fetch(`/api/scraps/${id}`)
    const payload = await response.json()
    if (response.ok) {
      setDetail({ type: 'scrap', item: payload.scrap as Scrap })
    }
  }

  async function openWikiDraft(id: string) {
    const response = await fetch(`/api/wiki/${id}`)
    const payload = await response.json()
    if (response.ok) {
      setDetail({ type: 'wiki', item: payload.draft as WikiDraft })
    }
  }

  async function openGraphNode(node: GraphifyNode) {
    // Raw scraps and wiki nodes reuse the primary detail panels; synthetic graph-only nodes resolve through the graph API.
    if (node.kind === 'scrap' && node.refId) {
      await openScrap(node.refId)
      return
    }
    if (node.kind === 'wiki' && node.refId) {
      await openWikiDraft(node.refId)
      return
    }
    const response = await fetch(`/api/graphify/node/${encodeURIComponent(node.id)}`)
    const payload = await response.json()
    if (response.ok) {
      setDetail({ type: 'graph', item: payload as GraphifyNodeDetail })
    }
  }

  function openGraphEdge(edgeId: string) {
    if (!graphify) return
    const edge = graphify.edges.find((item) => item.id === edgeId)
    if (!edge) return
    const sourceNode = graphify.nodes.find((item) => item.id === edge.source)
    const targetNode = graphify.nodes.find((item) => item.id === edge.target)
    if (!sourceNode || !targetNode) return
    const surprisingConnection = graphify.surprisingConnections.find((item) => item.edgeId === edgeId)
    setDetail({
      type: 'graph-edge',
      item: {
        edge,
        sourceNode,
        targetNode,
        surprisingConnection
      }
    })
  }

  async function bulkApproveDrafts(ids: string[], options: { openAfter?: boolean; appendMessage?: boolean } = {}) {
    if (ids.length === 0) return null

    const response = await fetch('/api/wiki/drafts/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    })
    const payload = await parseJsonResponse<{
      drafts?: WikiDraft[]
      approved?: number
      published?: number
      alreadyPublished?: number
      errors?: Array<{ id: string; message: string }>
      error?: string
    }>(response)

    if (!response.ok || !payload) {
      throw new Error(payload?.error ?? '위키 일괄 승인에 실패했습니다.')
    }

    await refresh(scrapQuery)
    setTab('wiki')

    const firstDraft = payload.drafts?.[0]
    if (options.openAfter !== false && firstDraft) {
      await openWikiDraft(firstDraft.id)
    }

    if (options.appendMessage !== false) {
      const summary = [
        payload.published ? `${payload.published}개 게시` : '',
        payload.alreadyPublished ? `${payload.alreadyPublished}개 이미 게시됨` : '',
        payload.errors?.length ? `${payload.errors.length}개 실패` : ''
      ].filter(Boolean).join(' · ')
      setMessages((current) => [
        ...current,
        { role: 'system', text: summary ? `선택한 위키를 일괄 승인했습니다. (${summary})` : '선택한 위키를 일괄 승인했습니다.' }
      ])
    }

    return payload
  }

  const handleWikiGenerationResponse = useCallback(async (payload: WikiGenerationResponse, options: { appendMessage?: boolean } = {}) => {
    const appendMessage = options.appendMessage ?? true
    if (payload.graphPayload) {
      setGraphify(payload.graphPayload)
    }
    const drafts = extractGeneratedDrafts(payload)
    if (drafts.length === 0) {
      if (appendMessage) {
        setMessages((current) => [
          ...current,
          {
            role: 'system',
            text: normalizeUiError(new Error(payload.message || '위키 초안을 생성했습니다.'), '위키 초안을 생성했습니다.')
          }
        ])
      }
      return
    }

    if (autoApproveWiki && drafts.some((draft) => draft.status === 'draft')) {
      await bulkApproveDrafts(drafts.map((draft) => draft.id), { openAfter: true, appendMessage })
      return
    }

    await refresh(scrapQuery)

    if (drafts.length === 1) {
      setTab('wiki')
      await openWikiDraft(drafts[0].id)
      if (appendMessage) {
        setMessages((current) => [...current, { role: 'system', text: buildWikiGenerationMessage(payload, drafts) }])
      }
      return
    }

    setTab('wiki')
    await openWikiDraft(drafts[0].id)
    if (appendMessage) {
      setMessages((current) => [...current, { role: 'system', text: buildWikiGenerationMessage(payload, drafts) }])
    }
  }, [autoApproveWiki, bulkApproveDrafts, refresh, scrapQuery])

  const runManualWikiAutoGenerate = useCallback(async () => {
    setLoading(true)
    setWikiProgress({ completed: 0, total: 0 })
    setMessages((current) => [...current, { role: 'system', text: '위키 생성/갱신을 시작했습니다.' }])
    try {
      const response = await fetch('/api/wiki/auto-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoApprove: autoApproveWiki })
      })
      if (!response.ok) {
        const payload = await parseJsonResponse<{ error?: string }>(response)
        throw new Error(payload?.error ?? '위키 생성/갱신에 실패했습니다.')
      }

      let handledResult = false
      await parseNdjsonStream(response, {
        onProgress: (progress) => {
          setWikiProgress(progress)
        },
        onResult: async (payload) => {
          handledResult = true
          if (Array.isArray(payload.drafts) && payload.drafts.length > 0) {
            await handleWikiGenerationResponse(payload, { appendMessage: true })
          } else {
            await refresh(scrapQuery)
            setMessages((current) => [
              ...current,
              { role: 'system', text: payload.message?.trim() || '새로 정리할 스크랩이 없어 위키 초안을 만들지 않았습니다.' }
            ])
          }
        },
        onError: (message) => {
          throw new Error(message)
        }
      })

      if (!handledResult) {
        throw new Error('위키 생성/갱신 결과를 받지 못했습니다.')
      }
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '위키 생성/갱신에 실패했습니다.') }])
    } finally {
      setWikiProgress(null)
      setLoading(false)
    }
  }, [handleWikiGenerationResponse, refresh, scrapQuery])

  const selectedScrapCount = selectedScrapIds.length

  function clearSelection() {
    setSelectedScrapIds([])
  }

  function clearWikiSelection() {
    setSelectedWikiIds([])
  }

  async function deleteSelectedScraps() {
    if (selectedScrapIds.length === 0) return
    setLoading(true)
    try {
      const response = await fetch('/api/scraps', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedScrapIds })
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? 'Failed to delete scraps')
      setMessages((current) => [...current, { role: 'system', text: `${payload.deleted}개의 스크랩을 삭제했습니다.` }])
      if (detail?.type === 'scrap' && selectedScrapIds.includes(detail.item.id)) {
        setDetail(null)
      }
      clearSelection()
      await refresh(scrapQuery)
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '스크랩 삭제에 실패했습니다.') }])
    } finally {
      setLoading(false)
    }
  }

  async function deleteSelectedWikis() {
    if (selectedWikiIds.length === 0) return
    setLoading(true)
    try {
      const response = await fetch('/api/wiki/drafts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedWikiIds })
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? 'Failed to delete wiki drafts')
      setMessages((current) => [...current, { role: 'system', text: `${payload.deleted}개의 위키 초안을 삭제했습니다.` }])
      if (detail?.type === 'wiki' && selectedWikiIds.includes(detail.item.id)) {
        setDetail(null)
      }
      clearWikiSelection()
      await refresh(scrapQuery)
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '위키 초안 삭제에 실패했습니다.') }])
    } finally {
      setLoading(false)
    }
  }

  async function approveSelectedWikis() {
    if (selectedWikiIds.length === 0) return
    setLoading(true)
    try {
      await bulkApproveDrafts(selectedWikiIds, { openAfter: false, appendMessage: true })
      if (detail?.type === 'wiki' && selectedWikiIds.includes(detail.item.id)) {
        await openWikiDraft(detail.item.id)
      }
      setSelectedWikiIds([])
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '위키 일괄 승인에 실패했습니다.') }])
    } finally {
      setLoading(false)
    }
  }

  async function handleChat() {
    if (!prompt.trim()) return
    const nextPrompt = prompt
    setPrompt('')
    setLoading(true)
    // Ask always targets the full knowledge base; selection state is only used for bulk management actions.
    setMessages((current) => [...current, { role: 'user', text: nextPrompt }])
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: nextPrompt
        } satisfies ChatRequestBody)
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? 'Failed to run chat')
      setMessages((current) => [...current, { role: payload.blocked ? 'system' : 'agent', text: payload.message }])
      if (payload.draft?.id || Array.isArray(payload.drafts)) {
        await handleWikiGenerationResponse(payload as WikiGenerationResponse, { appendMessage: false })
      }
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '채팅 실행에 실패했습니다.') }])
    } finally {
      setLoading(false)
    }
  }

  async function saveChatMessageToScrap(index: number) {
    const target = messages[index]
    if (!target || target.role !== 'agent') return
    // Persist the nearest preceding user turn with the assistant reply as one reusable Q/A scrap.
    const question = [...messages.slice(0, index)].reverse().find((message) => message.role === 'user')?.text?.trim() ?? ''
    const answer = target.text.trim()
    if (!question || !answer) return

    setSavingChatIndexes((current) => [...current, index])
    try {
      const response = await fetch('/api/scraps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer })
      })
      const payload = await parseJsonResponse<{ error?: string }>(response)
      if (!response.ok) {
        throw new Error(payload?.error ?? '대화 스크랩 저장에 실패했습니다.')
      }
      setSavedChatIndexes((current) => [...current, index])
      setMessages((current) => [...current, { role: 'system', text: '현재 질의와 답변을 스크랩에 저장했습니다.' }])
      await refresh(scrapQuery)
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '대화 스크랩 저장에 실패했습니다.') }])
    } finally {
      setSavingChatIndexes((current) => current.filter((value) => value !== index))
    }
  }

  async function approveDraft(id: string, options: { openAfter?: boolean } = {}) {
    const openAfter = options.openAfter ?? true
    setLoading(true)
    try {
      const approveResponse = await fetch(`/api/wiki/${id}/approve`, {
        method: 'POST'
      })
      const approvePayload = await approveResponse.json()
      if (!approveResponse.ok) {
        throw new Error(approvePayload.error ?? '초안 승인 실패')
      }

      const publishResponse = await fetch(`/api/wiki/${id}/publish`, {
        method: 'POST'
      })
      const publishPayload = await publishResponse.json()
      if (!publishResponse.ok) {
        throw new Error(publishPayload.error ?? 'Notion 게시 실패')
      }

      setMessages((current) => [
        ...current,
        {
          role: 'system',
          text: publishPayload.notionPage?.url
            ? `"${publishPayload.draft.title}" 위키를 승인하고 Notion에 저장했습니다: ${publishPayload.notionPage.url}`
            : `"${publishPayload.draft.title}" 위키를 승인하고 Notion에 저장했습니다.`
        }
      ])
      await refresh(scrapQuery)
      setTab('wiki')
      if (openAfter) {
        await openWikiDraft(publishPayload.draft.id)
      }
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '위키 승인 또는 Notion 저장에 실패했습니다.') }])
    } finally {
      setLoading(false)
    }
  }

  async function publishDraft(id: string, options: { openAfter?: boolean } = {}) {
    const openAfter = options.openAfter ?? true
    setLoading(true)
    try {
      const response = await fetch(`/api/wiki/${id}/publish`, {
        method: 'POST'
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.error ?? 'Notion 게시 실패')
      }
      setMessages((current) => [
        ...current,
        {
          role: 'system',
          text: payload.notionPage?.url
            ? `Notion에 게시했습니다: ${payload.notionPage.url}`
            : 'Notion에 위키 페이지를 게시했습니다.'
        }
      ])
      await refresh(scrapQuery)
      setTab('wiki')
      if (openAfter) {
        await openWikiDraft(payload.draft.id)
      }
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, 'Notion 게시에 실패했습니다.') }])
    } finally {
      setLoading(false)
    }
  }

  const scrapCards = useMemo(() => scraps, [scraps])
  const totalScrapPages = Math.max(1, Math.ceil(scrapCards.length / scrapsPerPage))
  const safeScrapPage = Math.min(currentScrapPage, totalScrapPages)
  const paginatedScrapCards = useMemo(() => {
    const startIndex = (safeScrapPage - 1) * scrapsPerPage
    return scrapCards.slice(startIndex, startIndex + scrapsPerPage)
  }, [safeScrapPage, scrapCards])
  const totalWikiPages = Math.max(1, Math.ceil(wikiDrafts.length / wikiPerPage))
  const safeWikiPage = Math.min(currentWikiPage, totalWikiPages)
  const paginatedWikiDrafts = useMemo(() => {
    const startIndex = (safeWikiPage - 1) * wikiPerPage
    return wikiDrafts.slice(startIndex, startIndex + wikiPerPage)
  }, [safeWikiPage, wikiDrafts])

  return (
    <main className='shell'>
      <aside className='panel left-panel'>
        <section className='section'>
          <h1 className='title left-hero-title'>ClipWiki Workspace</h1>
          <p className='muted small'>
            브라우저에서 <span className='inline-code'>Alt + Drag</span>로 스크랩하고, 저장된 자료를 바탕으로 위키 초안을 생성합니다.
          </p>
        </section>

        <section className='section stack ask-section'>
          <div className='chat-log' ref={chatLogRef}>
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={clsx('chat-item', message.role)}>
                <div className={clsx('bubble', message.role)}>
                  <div className='bubble-markdown'>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ node: _node, ...props }) => <a {...props} target='_blank' rel='noreferrer' />,
                        p: ({ node: _node, ...props }) => <p {...props} />,
                        code: ({ node: _node, className, children, ...props }) => (
                          <code className={clsx('inline-code', className)} {...props}>{children}</code>
                        )
                      }}
                    >
                      {message.text}
                    </ReactMarkdown>
                  </div>
                </div>
                {message.role === 'agent' ? (
                  <div className='chat-item-actions'>
                    <button
                      className='chat-save-button'
                      disabled={savingChatIndexes.includes(index) || savedChatIndexes.includes(index)}
                      onClick={() => void saveChatMessageToScrap(index)}
                      type='button'
                    >
                      {savedChatIndexes.includes(index) ? '저장됨' : savingChatIndexes.includes(index) ? '저장 중...' : '+'}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <textarea
            className='textarea ask-textarea'
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            placeholder='예: 저장된 위키와 스크랩을 바탕으로 MAD 프레임워크가 무엇인지 설명해줘. Enter로 전송하고 Shift+Enter로 줄바꿈합니다.'
          />
        </section>
      </aside>

      <section className='center-panel'>
        <div className='toolbar toolbar-stacked'>
          <div className='toolbar-row'>
            <div className='chip-row'>
              {[
                ['scraps', 'Scraps'],
                ['wiki', 'Wiki'],
                ['graphify', 'Graphify']
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={clsx('tab', tab === value && 'active')}
                  onClick={() => setTab(value as WorkspaceTab)}
                  type='button'
                >
                  {label}
                </button>
              ))}
            </div>
            {wikiProgress ? (
              <div className='toolbar-progress'>
                <span className='status-pill selected-pill'>
                  {wikiProgress.total > 0 ? `위키 생성 ${wikiProgress.completed} / ${wikiProgress.total}` : '위키 초안 준비 중'}
                </span>
                {wikiProgress.title ? (
                  <span className='muted small'>{wikiProgress.title}</span>
                ) : (
                  <span className='muted small'>선택한 스크랩을 정리하고 있습니다.</span>
                )}
              </div>
            ) : null}
            <div className='toolbar-stats'>
              <button className='action-button' onClick={() => void runManualGraphRebuild()} disabled={graphLoading || loading} type='button'>
                {graphLoading ? '그래프 갱신 중...' : '그래프 갱신'}
              </button>
              <button className='action-button' onClick={() => void runManualWikiAutoGenerate()} disabled={loading || graphLoading} type='button'>
                위키 생성/갱신
              </button>
              <span className='muted small'>Captured scraps: {scraps.length}</span>
              <span className='muted small'>Wiki drafts: {wikiDrafts.length}</span>
              <span className='muted small'>Updated: {lastUpdatedAt ?? 'never'}</span>
            </div>
          </div>

          {tab !== 'graphify' ? (
            <div className='toolbar-row toolbar-controls'>
              <div className='toolbar-block'>
                <label className='muted small toolbar-label'>Search scraps</label>
                <div className='toolbar-inline'>
                  <input
                    className='input'
                    value={scrapQuery}
                    onChange={(event) => setScrapQuery(event.target.value)}
                    placeholder='도메인, 텍스트, 태그 검색'
                  />
                  <button className='action-button primary' onClick={() => void refresh(scrapQuery)} disabled={refreshing} type='button'>
                    {refreshing ? 'Refreshing...' : 'Refresh'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {tab !== 'graphify' ? (
            <div className='selection-bar'>
            <div className='selection-summary'>
              <span className='status-pill selected-pill'>
                {tab === 'scraps'
                  ? `${selectedScrapCount} selected`
                  : tab === 'wiki'
                    ? `${selectedWikiIds.length} selected`
                    : ''}
              </span>
              {tab === 'scraps' ? (
                <span className='muted small'>
                  선택한 스크랩은 삭제에만 사용됩니다.
                </span>
              ) : tab === 'wiki' ? (
                <span className='muted small'>
                  선택한 위키 초안을 일괄 승인하거나 삭제할 수 있습니다.
                </span>
              ) : null}
            </div>
            {tab === 'scraps' ? (
              <div className='button-row'>
                <button
                  className='action-button'
                  onClick={() =>
                    setSelectedScrapIds((current) =>
                      current.length === scrapCards.length && scrapCards.length > 0
                        ? []
                        : scrapCards.map((scrap) => scrap.id)
                    )
                  }
                  disabled={scrapCards.length === 0}
                  type='button'
                >
                  {selectedScrapCount === scrapCards.length && scrapCards.length > 0 ? 'Clear All' : 'Select All'}
                </button>
                <button className='action-button danger' onClick={deleteSelectedScraps} disabled={selectedScrapCount === 0 || loading} type='button'>
                  <span aria-hidden='true'>🗑</span>
                  <span className='sr-only'>Delete Selected</span>
                </button>
              </div>
            ) : tab === 'wiki' ? (
              <div className='button-row'>
                <label className='toggle-chip' htmlFor='auto-approve-wiki'>
                  <input
                    id='auto-approve-wiki'
                    checked={autoApproveWiki}
                    onChange={(event) => setAutoApproveWiki(event.target.checked)}
                    type='checkbox'
                  />
                  <span>Auto approve</span>
                </label>
                <button
                  className='action-button'
                  onClick={() =>
                    setSelectedWikiIds((current) =>
                      current.length === wikiDrafts.length && wikiDrafts.length > 0
                        ? []
                        : wikiDrafts.map((draft) => draft.id)
                    )
                  }
                  disabled={wikiDrafts.length === 0}
                  type='button'
                >
                  {selectedWikiIds.length === wikiDrafts.length && wikiDrafts.length > 0 ? 'Clear All' : 'Select All'}
                </button>
                <button
                  className='action-button success'
                  onClick={approveSelectedWikis}
                  disabled={selectedWikiIds.length === 0 || loading}
                  type='button'
                >
                  Approve Selected
                </button>
                <button className='action-button danger' onClick={deleteSelectedWikis} disabled={selectedWikiIds.length === 0 || loading} type='button'>
                  <span aria-hidden='true'>🗑</span>
                  <span className='sr-only'>Delete Selected</span>
                </button>
              </div>
            ) : null}
            </div>
          ) : null}
        </div>

        <div className='list'>
          {tab === 'scraps' ? (
            <div className='cards'>
              {paginatedScrapCards.map((scrap) => {
                const selected = selectedScrapIds.includes(scrap.id)
                return (
                  <div key={scrap.id} className={clsx('card', selected && 'card-selected')}>
                    <div className='card-header'>
                      <div>
                        <h3>{scrap.title}</h3>
                        <p>{scrap.summary || '스크랩 본문이 아직 없습니다.'}</p>
                      </div>
                      <span className={clsx('status-pill', selected && 'selected-pill')}>
                        {selected ? 'Selected' : 'Ready'}
                      </span>
                    </div>
                    <div className='meta'>
                      <span>{scrap.captureType}</span>
                      <span>{scrap.sourceHost}</span>
                      <span>{new Date(scrap.capturedAt).toLocaleString()}</span>
                      <span>{scrap.imageCount} assets</span>
                      {scrap.tags.map((tag) => <span key={tag}>{tag}</span>)}
                    </div>
                    <div className='button-row card-actions' style={{ marginTop: 12 }}>
                      <button
                        className={clsx('action-button', selected && 'success')}
                        onClick={() =>
                          setSelectedScrapIds((current) =>
                            selected
                              ? current.filter((id) => id !== scrap.id)
                              : [...current, scrap.id]
                          )
                        }
                        type='button'
                      >
                        {selected ? 'Deselect' : 'Select'}
                      </button>
                      <button className='action-button' onClick={() => void openScrap(scrap.id)} type='button'>
                        Open
                      </button>
                    </div>
                  </div>
                )
              })}
              {scrapCards.length === 0 ? (
                <div className='empty'>
                  아직 저장된 스크랩이 없습니다. 크롬 익스텐션에서 <span className='inline-code'>Alt + Drag</span>로 영역을 선택해 저장하세요.
                </div>
              ) : null}
              {scrapCards.length > scrapsPerPage ? (
                <div className='pagination'>
                  <button
                    className='pagination-button nav'
                    disabled={safeScrapPage === 1}
                    onClick={() => setCurrentScrapPage((current) => Math.max(1, current - 1))}
                    type='button'
                  >
                    Previous
                  </button>
                  {Array.from({ length: totalScrapPages }, (_, index) => index + 1).map((page) => (
                    <button
                      key={page}
                      className={clsx('pagination-button', page === safeScrapPage && 'active')}
                      onClick={() => setCurrentScrapPage(page)}
                      type='button'
                    >
                      {page}
                    </button>
                  ))}
                  <button
                    className='pagination-button nav'
                    disabled={safeScrapPage === totalScrapPages}
                    onClick={() => setCurrentScrapPage((current) => Math.min(totalScrapPages, current + 1))}
                    type='button'
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === 'wiki' ? (
            <div className='cards'>
              {paginatedWikiDrafts.map((draft) => {
                const selected = selectedWikiIds.includes(draft.id)
                return (
                  <div
                    key={draft.id}
                    className={clsx('card', selected && 'card-selected')}
                    style={{ textAlign: 'left' }}
                  >
                  <div className='card-header'>
                    <div>
                      <h3>{draft.title}</h3>
                      <p>{draft.summary}</p>
                    </div>
                    <span className={clsx('status-pill', selected ? 'selected-pill' : draft.status)}>{selected ? 'Selected' : draft.status}</span>
                  </div>
                  <div className='meta'>
                    <span>{draft.mode}</span>
                    <span>{draft.topic}</span>
                    <span>{draft.scrapCount} scraps</span>
                    <span>{new Date(draft.updatedAt).toLocaleString()}</span>
                  </div>
                    <div className='button-row card-actions' style={{ marginTop: 12 }}>
                      {draft.status === 'draft' ? (
                        <button className='action-button success' onClick={() => void approveDraft(draft.id, { openAfter: false })} disabled={loading} type='button'>
                          Approve
                        </button>
                      ) : null}
                      {draft.status === 'approved' ? (
                        <button className='action-button primary' onClick={() => void publishDraft(draft.id, { openAfter: false })} disabled={loading} type='button'>
                          Publish
                        </button>
                      ) : null}
                      <button
                        className={clsx('action-button', selected && 'success')}
                        onClick={() =>
                          setSelectedWikiIds((current) =>
                            selected
                              ? current.filter((id) => id !== draft.id)
                              : [...new Set([...current, draft.id])]
                          )
                        }
                        type='button'
                      >
                        {selected ? 'Deselect' : 'Select'}
                      </button>
                      <button className='action-button' onClick={() => void openWikiDraft(draft.id)} type='button'>
                        Open
                      </button>
                    </div>
                  </div>
                )
              })}
              {wikiDrafts.length === 0 ? (
                <div className='empty'>아직 위키 초안이 없습니다. 스크랩을 선택한 뒤 Generate Wiki를 눌러 초안을 만드세요.</div>
              ) : null}
              {wikiDrafts.length > wikiPerPage ? (
                <div className='pagination'>
                  <button
                    className='pagination-button nav'
                    disabled={safeWikiPage === 1}
                    onClick={() => setCurrentWikiPage((current) => Math.max(1, current - 1))}
                    type='button'
                  >
                    Previous
                  </button>
                  {Array.from({ length: totalWikiPages }, (_, index) => index + 1).map((page) => (
                    <button
                      key={page}
                      className={clsx('pagination-button', page === safeWikiPage && 'active')}
                      onClick={() => setCurrentWikiPage(page)}
                      type='button'
                    >
                      {page}
                    </button>
                  ))}
                  <button
                    className='pagination-button nav'
                    disabled={safeWikiPage === totalWikiPages}
                    onClick={() => setCurrentWikiPage((current) => Math.min(totalWikiPages, current + 1))}
                    type='button'
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === 'graphify' ? (
            <GraphifyView
              payload={graphify}
              onOpenNode={openGraphNode}
              onOpenSurprisingEdge={openGraphEdge}
            />
          ) : null}

        </div>
      </section>

      <aside className='panel detail-scroll'>
        <section className='section'>
          <h2 className='title'>Detail & Publish</h2>
          <p className='muted small'>
            스크랩은 Notion DB에 저장되고, 위키 초안은 승인 후 별도 Notion 루트 페이지 아래로 게시됩니다.
          </p>
        </section>

        <section className='section stack'>
          {detail?.type === 'scrap' ? (
            <>
              <h3 className='title'>{detail.item.title}</h3>
              <div className='meta'>
                <span>{detail.item.captureType}</span>
                <span>{detail.item.sourceHost}</span>
                <span>{new Date(detail.item.capturedAt).toLocaleString()}</span>
              </div>
              <div className='empty'>
                <a href={detail.item.sourceUrl} target='_blank' rel='noreferrer'>
                  {detail.item.sourceUrl}
                </a>
              </div>
              {detail.item.userNote ? (
                <div className='empty'>
                  <strong>User note</strong>
                  <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{detail.item.userNote}</div>
                </div>
              ) : null}
              <div className='empty stack' style={{ gap: 14 }}>
                <div>
                  <strong>Captured text</strong>
                  <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    {detail.item.mergedText || '(No captured text)'}
                  </div>
                </div>
                {detail.item.ocrText ? (
                  <div>
                    <strong>OCR</strong>
                    <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{detail.item.ocrText}</div>
                  </div>
                ) : null}
              </div>
              {detail.item.images.length > 0 || detail.item.screenshot ? (
                <div className='empty'>
                  <strong>Assets</strong>
                  <div className='stack' style={{ marginTop: 12 }}>
                    {detail.item.images.map((image) => (
                      <div key={image.id} className='meta'>
                        <span>{image.filename}</span>
                        <span>{image.status}</span>
                        {image.sourceUrl ? <span>{image.sourceUrl}</span> : null}
                      </div>
                    ))}
                    {detail.item.screenshot ? (
                      <div className='meta'>
                        <span>{detail.item.screenshot.filename}</span>
                        <span>region screenshot</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {detail?.type === 'wiki' ? (
            <>
              <h3 className='title'>{detail.item.title}</h3>
              <div className='meta'>
                <span>{detail.item.status}</span>
                <span>{detail.item.mode}</span>
                <span>{detail.item.topic}</span>
                <span>{detail.item.scrapIds.length} scraps</span>
              </div>
              <div className='wiki-detail'>
                <section className='wiki-block'>
                  <h4 className='wiki-block-title'>요약</h4>
                  <p className='wiki-summary'>{detail.item.summary}</p>
                </section>

                {detail.item.keyConcepts.length > 0 ? (
                  <section className='wiki-block'>
                    <h4 className='wiki-block-title'>핵심 개념</h4>
                    <div className='wiki-chip-list'>
                      {detail.item.keyConcepts.map((concept) => (
                        <span key={concept} className='wiki-chip'>{concept}</span>
                      ))}
                    </div>
                  </section>
                ) : null}

                {detail.item.claims.length > 0 ? (
                  <section className='wiki-block'>
                    <h4 className='wiki-block-title'>주장과 메모</h4>
                    <div className='wiki-claim-list'>
                      {detail.item.claims.map((claim, index) => (
                        <article key={`${claim.claim}-${index}`} className='wiki-claim-card'>
                          <div className='wiki-claim-head'>
                            <strong>{claim.claim}</strong>
                            <span className={clsx('status-pill', claim.supportLevel === 'supported' && 'published', claim.supportLevel === 'weak' && 'draft', claim.supportLevel === 'conflicting' && 'approved')}>
                              {claim.supportLevel}
                            </span>
                          </div>
                          {claim.evidence.length > 0 ? (
                            <ul className='wiki-list'>
                              {claim.evidence.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}

                {detail.item.openQuestions.length > 0 ? (
                  <section className='wiki-block'>
                    <h4 className='wiki-block-title'>열린 질문</h4>
                    <ul className='wiki-list'>
                      {detail.item.openQuestions.map((question) => (
                        <li key={question}>{question}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {detail.item.sections.length > 0 ? (
                  <section className='wiki-block'>
                    <h4 className='wiki-block-title'>본문</h4>
                    <div className='wiki-section-list'>
                      {detail.item.sections.map((section, index) => (
                        <article key={`${section.heading}-${index}`} className='wiki-section-card'>
                          <h5 className='wiki-section-title'>{section.heading}</h5>
                          {section.paragraphs.map((paragraph, paragraphIndex) => (
                            <p key={`${section.heading}-p-${paragraphIndex}`} className='wiki-paragraph'>{paragraph}</p>
                          ))}
                          {section.bullets.length > 0 ? (
                            <ul className='wiki-list'>
                              {section.bullets.map((bullet) => (
                                <li key={bullet}>{bullet}</li>
                              ))}
                            </ul>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
              <div className='button-row'>
                {detail.item.status === 'approved' ? (
                  <button className='action-button primary' onClick={() => void publishDraft(detail.item.id)} disabled={loading} type='button'>
                    Publish To Notion
                  </button>
                ) : null}
              </div>
            </>
          ) : null}

          {detail?.type === 'graph' ? (
            <>
              <h3 className='title'>{detail.item.node.label}</h3>
              <div className='meta'>
                <span>{detail.item.node.kind}</span>
                <span>{detail.item.node.provenance}</span>
                <span>degree {detail.item.node.degree}</span>
                {detail.item.node.clusterId ? <span>{detail.item.node.clusterId}</span> : null}
              </div>
              {detail.item.node.summary ? (
                <div className='wiki-detail'>
                  <section className='wiki-block'>
                    <h4 className='wiki-block-title'>요약</h4>
                    <p className='wiki-summary'>{detail.item.node.summary}</p>
                  </section>
                  <section className='wiki-block'>
                    <h4 className='wiki-block-title'>연결된 노드</h4>
                    <div className='wiki-claim-list'>
                      {detail.item.neighbors.map((neighbor) => (
                        <article key={neighbor.edge.id} className='wiki-claim-card'>
                          <div className='wiki-claim-head'>
                            <strong>{neighbor.node.label}</strong>
                            <span className={clsx('status-pill', neighbor.edge.provenance === 'INFERRED' && 'approved')}>
                              {neighbor.edge.relation}
                            </span>
                          </div>
                          <p className='wiki-paragraph'>
                            {neighbor.edge.provenance} · confidence {neighbor.edge.confidence.toFixed(2)}
                          </p>
                          {neighbor.edge.explanation ? (
                            <p className='wiki-paragraph'>{neighbor.edge.explanation}</p>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
              ) : null}
            </>
          ) : null}

          {detail?.type === 'graph-edge' ? (
            <>
              <h3 className='title'>놀라운 연결</h3>
              <div className='meta'>
                <span>{detail.item.edge.relation}</span>
                <span>{detail.item.edge.provenance}</span>
                <span>confidence {detail.item.edge.confidence.toFixed(2)}</span>
              </div>
              <div className='wiki-detail'>
                <section className='wiki-block'>
                  <h4 className='wiki-block-title'>연결된 위키</h4>
                  <div className='wiki-claim-list'>
                    <article className='wiki-claim-card'>
                      <div className='wiki-claim-head'>
                        <strong>{detail.item.sourceNode.label}</strong>
                        <span className='status-pill published'>{detail.item.sourceNode.kind}</span>
                      </div>
                      {detail.item.sourceNode.summary ? (
                        <p className='wiki-paragraph'>{detail.item.sourceNode.summary}</p>
                      ) : null}
                    </article>
                    <article className='wiki-claim-card'>
                      <div className='wiki-claim-head'>
                        <strong>{detail.item.targetNode.label}</strong>
                        <span className='status-pill published'>{detail.item.targetNode.kind}</span>
                      </div>
                      {detail.item.targetNode.summary ? (
                        <p className='wiki-paragraph'>{detail.item.targetNode.summary}</p>
                      ) : null}
                    </article>
                  </div>
                </section>

                <section className='wiki-block'>
                  <h4 className='wiki-block-title'>왜 이렇게 판단했는가</h4>
                  <p className='wiki-summary'>
                    {detail.item.surprisingConnection?.explanation ?? detail.item.edge.explanation ?? '이 연결에는 아직 설명이 없습니다.'}
                  </p>
                </section>

                <section className='wiki-block'>
                  <h4 className='wiki-block-title'>추가 질문 팁</h4>
                  <ul className='wiki-list'>
                    <li>
                      좌측 패널에서 <strong>{detail.item.sourceNode.label}</strong> 와 <strong>{detail.item.targetNode.label}</strong> 가 왜 연결되는지 더 자세히 물어볼 수 있습니다.
                    </li>
                    <li>
                      예: <code>{detail.item.sourceNode.label}와 {detail.item.targetNode.label}의 공통 아이디어를 설명해줘</code>
                    </li>
                  </ul>
                </section>
              </div>
            </>
          ) : null}

          {!detail ? (
            <div className='empty'>스크랩이나 위키 초안을 열면 상세 정보와 게시 액션이 여기에 표시됩니다.</div>
          ) : null}
        </section>
      </aside>
    </main>
  )
}
