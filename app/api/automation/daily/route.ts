import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  getSystemMetaValue,
  listScraps,
  listWikiDrafts,
  setSystemMetaValue
} from '@/lib/server/db'
import { rebuildGraphifyPayload } from '@/lib/server/graphify'
import { createWikiDraftsFromSelection } from '@/lib/server/openai'

export const runtime = 'nodejs'

const requestSchema = z.object({
  forceGraph: z.boolean().optional().default(false),
  forceWiki: z.boolean().optional().default(false)
})

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

function latestCapturedAtIso() {
  const scraps = listScraps(500)
  if (scraps.length === 0) return null
  return scraps.reduce((latest, scrap) => {
    const candidate = scrap.updatedAt || scrap.capturedAt
    return !latest || new Date(candidate).getTime() > new Date(latest).getTime() ? candidate : latest
  }, '' as string | null)
}

function hasNewUnassignedScrapsSince(lastRunAt: string | null) {
  const drafts = listWikiDrafts(500)
  const assignedIds = new Set(drafts.flatMap((draft) => draft.scrapIds))
  const threshold = lastRunAt ? new Date(lastRunAt).getTime() : 0
  return listScraps(500).some((scrap) => {
    if (assignedIds.has(scrap.id)) return false
    const capturedAt = new Date(scrap.updatedAt || scrap.capturedAt).getTime()
    return capturedAt > threshold
  })
}

function getFreshUnassignedScraps() {
  const drafts = listWikiDrafts(500)
  const assignedIds = new Set(drafts.flatMap((draft) => draft.scrapIds))
  return listScraps(500).filter((scrap) => !assignedIds.has(scrap.id))
}

export async function POST(request: NextRequest) {
  try {
    const body = request.headers.get('content-type')?.includes('application/json')
      ? await request.json()
      : {}
    const parsed = requestSchema.parse(body)
    const today = todayKey()

    const graphAutoKey = 'graphify:last_auto_run_date'
    const graphManualKey = 'graphify:last_manual_run_at'
    const wikiAutoDateKey = 'wiki:last_auto_run_date'
    const wikiAutoRunAtKey = 'wiki:last_auto_run_at'
    const wikiManualKey = 'wiki:last_manual_run_at'

    let graphRebuilt = false
    let wikiGenerated = false
    let wikiDraftCount = 0
    let drafts = [] as Awaited<ReturnType<typeof createWikiDraftsFromSelection>>
    let graphPayload: Awaited<ReturnType<typeof rebuildGraphifyPayload>> | null = null

    const latestScrapAt = latestCapturedAtIso()
    const lastWikiAutoRunAt = getSystemMetaValue(wikiAutoRunAtKey)
    // Run wiki generation at most once per day, and only when new unassigned scraps arrived since the last auto run.
    const shouldRunWiki = parsed.forceWiki || (
      getSystemMetaValue(wikiAutoDateKey) !== today &&
      Boolean(latestScrapAt) &&
      hasNewUnassignedScrapsSince(lastWikiAutoRunAt)
    )

    if (shouldRunWiki) {
      const freshScraps = getFreshUnassignedScraps()
      if (freshScraps.length > 0) {
        drafts = await createWikiDraftsFromSelection('', freshScraps, 'general')
        wikiGenerated = drafts.length > 0
        wikiDraftCount = drafts.length
      }
      if (parsed.forceWiki) {
        setSystemMetaValue(wikiManualKey, new Date().toISOString())
      } else {
        setSystemMetaValue(wikiAutoDateKey, today)
        setSystemMetaValue(wikiAutoRunAtKey, new Date().toISOString())
      }
    }

    // Rebuild the graph daily or immediately after wiki generation so Graphify and Ask stay in sync.
    const shouldRunGraph = parsed.forceGraph || getSystemMetaValue(graphAutoKey) !== today || wikiGenerated
    if (shouldRunGraph) {
      graphPayload = await rebuildGraphifyPayload()
      graphRebuilt = true
      if (parsed.forceGraph) {
        setSystemMetaValue(graphManualKey, new Date().toISOString())
      } else {
        setSystemMetaValue(graphAutoKey, today)
      }
    }

    return NextResponse.json({
      ok: true,
      graphRebuilt,
      wikiGenerated,
      wikiDraftCount,
      drafts,
      graphPayload,
      today
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Daily automation failed' },
      { status: 400 }
    )
  }
}
