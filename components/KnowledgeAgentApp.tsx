'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import type { ChatRequestBody, Scrap, ScrapSummary, WikiDraft, WikiDraftSummary, WikiGenerationResponse } from '@/lib/types'

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

type WorkspaceTab = 'scraps' | 'wiki'
const maxSelectedScraps = 100
type DetailState =
  | { type: 'scrap'; item: Scrap }
  | { type: 'wiki'; item: WikiDraft }
  | null

export default function KnowledgeAgentApp() {
  const [tab, setTab] = useState<WorkspaceTab>('scraps')
  const [scraps, setScraps] = useState<ScrapSummary[]>([])
  const [wikiDrafts, setWikiDrafts] = useState<WikiDraftSummary[]>([])
  const [selectedScrapIds, setSelectedScrapIds] = useState<string[]>([])
  const [selectedWikiIds, setSelectedWikiIds] = useState<string[]>([])
  const [detail, setDetail] = useState<DetailState>(null)
  const [scrapQuery, setScrapQuery] = useState('')
  const [wikiTopic, setWikiTopic] = useState('')
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [wikiProgress, setWikiProgress] = useState<{ completed: number; total: number; title?: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'system',
      text: 'ClipWiki는 브라우저 스크랩을 Notion에 저장하고, 누적된 스크랩을 바탕으로 LLM-Wiki 초안을 만드는 학습 보조 에이전트입니다.'
    }
  ])
  const chatLogRef = useRef<HTMLDivElement | null>(null)

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
    node.scrollTo({
      top: node.scrollHeight,
      behavior: 'smooth'
    })
  }, [messages, loading])

  const refresh = useCallback(async (query = scrapQuery) => {
    setRefreshing(true)
    try {
      const queryParam = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ''
      const [scrapResponse, wikiResponse] = await Promise.all([
        fetch(`/api/scraps${queryParam}`).then((res) => res.json()) as Promise<{ scraps: ScrapSummary[] }>,
        fetch('/api/wiki/drafts').then((res) => res.json()) as Promise<{ drafts: WikiDraftSummary[] }>
      ])
      setScraps(scrapResponse.scraps)
      setWikiDrafts(wikiResponse.drafts)
      setLastUpdatedAt(new Date().toLocaleTimeString())
    } finally {
      setRefreshing(false)
    }
  }, [scrapQuery])

  useEffect(() => {
    void refresh('')
  }, [refresh])

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

  async function handleWikiGenerationResponse(payload: WikiGenerationResponse, options: { appendMessage?: boolean } = {}) {
    const appendMessage = options.appendMessage ?? true
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
  }

  const selectedScrapCount = selectedScrapIds.length

  async function handleGenerateWiki() {
    if (selectedScrapIds.length === 0) return
    setLoading(true)
    setWikiProgress({ completed: 0, total: 0 })
    try {
      const response = await fetch('/api/wiki/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: wikiTopic.trim(),
          selectedScrapIds
        })
      })
      if (!response.ok) {
        const payload = await response.json() as { error?: string }
        throw new Error(payload.error ?? 'Failed to generate wiki draft')
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('위키 초안 생성 스트림을 읽을 수 없습니다.')
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let finalPayload: WikiGenerationResponse | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const event = JSON.parse(trimmed) as
            | { type: 'progress'; completed: number; total: number; title?: string }
            | { type: 'result'; payload: WikiGenerationResponse }
            | { type: 'error'; message: string }

          if (event.type === 'progress') {
            setWikiProgress({
              completed: event.completed,
              total: event.total,
              title: event.title
            })
            continue
          }

          if (event.type === 'error') {
            throw new Error(event.message)
          }

          finalPayload = event.payload
        }
      }

      if (!finalPayload) {
        throw new Error('위키 초안 생성 결과를 받지 못했습니다.')
      }

      await handleWikiGenerationResponse(finalPayload)
    } catch (error) {
      setMessages((current) => [...current, { role: 'system', text: normalizeUiError(error, '위키 초안 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.') }])
    } finally {
      setWikiProgress(null)
      setLoading(false)
    }
  }

  function clearSelection() {
    setSelectedScrapIds([])
  }

  function clearWikiSelection() {
    setSelectedWikiIds([])
  }

  function toggleSelectAllVisible() {
    if (scrapCards.length === 0) return
    const visibleIds = scrapCards.map((scrap) => scrap.id)
    const allSelected = visibleIds.every((id) => selectedScrapIds.includes(id))
    setSelectedScrapIds((current) => {
      if (allSelected) return current.filter((id) => !visibleIds.includes(id))
      const next = [...new Set([...current, ...visibleIds])]
      if (next.length > maxSelectedScraps) {
        setMessages((messages) => [
          ...messages,
          { role: 'system', text: `한 번에 최대 ${maxSelectedScraps}개의 스크랩만 선택할 수 있습니다.` }
        ])
      }
      return next.slice(0, maxSelectedScraps)
    })
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

  async function handleChat() {
    if (!prompt.trim()) return
    const nextPrompt = prompt
    setPrompt('')
    setLoading(true)
    setMessages((current) => [...current, { role: 'user', text: nextPrompt }])
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: nextPrompt,
          selectedScrapIds
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
  const allVisibleSelected = scrapCards.length > 0 && scrapCards.every((scrap) => selectedScrapIds.includes(scrap.id))
  const allVisibleWikiSelected = wikiDrafts.length > 0 && wikiDrafts.every((draft) => selectedWikiIds.includes(draft.id))

  return (
    <main className='shell'>
      <aside className='panel left-panel'>
        <section className='section'>
          <p className='muted small'>Chrome Scrap to Notion to LLM-Wiki</p>
          <h1 className='title left-hero-title'>ClipWiki Workspace</h1>
          <p className='muted small'>
            브라우저에서 <span className='inline-code'>Alt + Drag</span>로 스크랩하고, 저장된 자료를 바탕으로 위키 초안을 생성합니다.
          </p>
        </section>

        <section className='section stack ask-section'>
          <h2 className='title'>Ask over scraps</h2>
          <p className='muted small'>
            {selectedScrapCount > 0
              ? `${selectedScrapCount}개의 스크랩이 선택되어 있습니다. 선택한 자료만 기준으로 답변하거나 위키 초안을 만들 수 있습니다.`
              : '질문 전에 스크랩을 선택하면 범위를 좁힐 수 있습니다.'}
          </p>
          <div className='chat-log' ref={chatLogRef}>
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={clsx('bubble', message.role)}>
                {message.text}
              </div>
            ))}
          </div>
          <textarea
            className='textarea ask-textarea'
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            placeholder='예: 선택한 스크랩들에서 공통 개념과 약한 주장만 정리해줘.'
          />
          <div className='button-row'>
            <button className='action-button primary strong' onClick={handleChat} disabled={loading} type='button'>
              Run Chat
            </button>
            <button className='action-button' onClick={clearSelection} disabled={selectedScrapCount === 0} type='button'>
              Clear Selection
            </button>
          </div>
        </section>
      </aside>

      <section className='center-panel'>
        <div className='toolbar toolbar-stacked'>
          <div className='toolbar-row'>
            <div className='chip-row'>
              {[
                ['scraps', 'Scraps'],
                ['wiki', 'Wiki']
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
              <span className='muted small'>Captured scraps: {scraps.length}</span>
              <span className='muted small'>Wiki drafts: {wikiDrafts.length}</span>
              <span className='muted small'>Updated: {lastUpdatedAt ?? 'never'}</span>
            </div>
          </div>

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

            <div className='toolbar-block'>
              <label className='muted small toolbar-label'>Create wiki draft</label>
              <div className='toolbar-inline'>
                <input
                  className='input'
                  value={wikiTopic}
                  onChange={(event) => setWikiTopic(event.target.value)}
                  placeholder='주제를 비워두면 자동으로 제목과 구조를 만듭니다'
                />
                <button className='action-button primary strong' onClick={handleGenerateWiki} disabled={loading || selectedScrapCount === 0} type='button'>
                  Generate Wiki
                </button>
              </div>
            </div>
          </div>

          <div className='selection-bar'>
            <div className='selection-summary'>
              <span className='status-pill selected-pill'>
                {tab === 'scraps' ? `${selectedScrapCount} selected` : `${selectedWikiIds.length} selected`}
              </span>
              {tab === 'scraps' ? (
                <span className='muted small'>
                  {allVisibleSelected ? '현재 보이는 스크랩이 모두 선택됨' : `선택한 스크랩으로 채팅/위키 생성 가능 · 최대 ${maxSelectedScraps}개`}
                </span>
              ) : (
                <span className='muted small'>
                  {allVisibleWikiSelected ? '현재 보이는 위키 초안이 모두 선택됨' : '선택한 위키 초안을 삭제할 수 있습니다.'}
                </span>
              )}
            </div>
            {tab === 'scraps' ? (
              <div className='button-row'>
                <button className='action-button' onClick={toggleSelectAllVisible} disabled={scrapCards.length === 0} type='button'>
                  {allVisibleSelected ? 'Deselect Visible' : 'Select Visible'}
                </button>
                <button className='action-button' onClick={clearSelection} disabled={selectedScrapCount === 0} type='button'>
                  Clear Selected
                </button>
                <button className='action-button danger' onClick={deleteSelectedScraps} disabled={selectedScrapCount === 0 || loading} type='button'>
                  Delete Selected
                </button>
              </div>
            ) : (
              <div className='button-row'>
                <button
                  className='action-button'
                  onClick={() => {
                    const visibleIds = wikiDrafts.map((draft) => draft.id)
                    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedWikiIds.includes(id))
                    setSelectedWikiIds((current) =>
                      allSelected
                        ? current.filter((id) => !visibleIds.includes(id))
                        : [...new Set([...current, ...visibleIds])].slice(0, 100)
                    )
                  }}
                  disabled={wikiDrafts.length === 0}
                  type='button'
                >
                  {allVisibleWikiSelected ? 'Deselect Visible' : 'Select Visible'}
                </button>
                <button className='action-button' onClick={clearWikiSelection} disabled={selectedWikiIds.length === 0} type='button'>
                  Clear Selected
                </button>
                <button className='action-button danger' onClick={deleteSelectedWikis} disabled={selectedWikiIds.length === 0 || loading} type='button'>
                  Delete Selected
                </button>
              </div>
            )}
          </div>
        </div>

        <div className='list'>
          {tab === 'scraps' ? (
            <div className='cards'>
              {scrapCards.map((scrap) => {
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
                              : current.length >= maxSelectedScraps
                                ? current
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
            </div>
          ) : null}

          {tab === 'wiki' ? (
            <div className='cards'>
              {wikiDrafts.map((draft) => {
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
                              : [...new Set([...current, draft.id])].slice(0, 100)
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
            </div>
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

          {!detail ? (
            <div className='empty'>스크랩이나 위키 초안을 열면 상세 정보와 게시 액션이 여기에 표시됩니다.</div>
          ) : null}
        </section>
      </aside>
    </main>
  )
}
