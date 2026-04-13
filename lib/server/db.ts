import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import type { Scrap, ScrapSummary, WikiDraft, WikiDraftStatus, WikiDraftSummary } from '@/lib/types'

const dataDir = path.join(process.cwd(), 'data')
const dbPath = path.join(dataDir, 'clipwiki.sqlite')

let dbInstance: Database.Database | null = null

type ScrapRow = {
  id: string
  notion_page_id: string | null
  title: string
  page_title: string
  source_url: string
  source_host: string
  selected_text: string
  ocr_text: string
  merged_text: string
  capture_type: Scrap['captureType']
  user_note: string
  tags_json: string
  images_json: string
  screenshot_json: string | null
  metadata_json: string
  captured_at: string
  created_at: string
  updated_at: string
}

type DraftRow = {
  id: string
  notion_page_id: string | null
  title: string
  topic: string
  mode: WikiDraft['mode']
  status: WikiDraftStatus
  summary: string
  key_concepts_json: string
  claims_json: string
  open_questions_json: string
  sections_json: string
  scrap_ids_json: string
  source_links_json: string
  created_at: string
  updated_at: string
}

function ensureDb() {
  if (dbInstance) return dbInstance
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraps (
      id TEXT PRIMARY KEY,
      notion_page_id TEXT,
      title TEXT NOT NULL,
      page_title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_host TEXT NOT NULL,
      selected_text TEXT NOT NULL,
      ocr_text TEXT NOT NULL,
      merged_text TEXT NOT NULL,
      capture_type TEXT NOT NULL,
      user_note TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      images_json TEXT NOT NULL,
      screenshot_json TEXT,
      metadata_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS scraps_source_host_idx ON scraps(source_host);
    CREATE INDEX IF NOT EXISTS scraps_captured_at_idx ON scraps(captured_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_drafts (
      id TEXT PRIMARY KEY,
      notion_page_id TEXT,
      title TEXT NOT NULL,
      topic TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      key_concepts_json TEXT NOT NULL,
      claims_json TEXT NOT NULL,
      open_questions_json TEXT NOT NULL,
      sections_json TEXT NOT NULL,
      scrap_ids_json TEXT NOT NULL,
      source_links_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS wiki_drafts_updated_idx ON wiki_drafts(updated_at DESC);
  `)
  dbInstance = db
  return db
}

function nowIso() {
  return new Date().toISOString()
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  return JSON.parse(value) as T
}

export function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function scrapFromRow(row: ScrapRow): Scrap {
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {})
  const anchorChunks = Array.isArray(metadata.anchorChunks) ? metadata.anchorChunks : []
  const contextChunks = Array.isArray(metadata.contextChunks) ? metadata.contextChunks : []
  const semanticChunks = Array.isArray(metadata.semanticChunks) ? metadata.semanticChunks : []
  const selectionRect = metadata.selectionRect && typeof metadata.selectionRect === 'object'
    ? metadata.selectionRect as Scrap['selectionRect']
    : null

  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    title: row.title,
    pageTitle: row.page_title,
    sourceUrl: row.source_url,
    sourceHost: row.source_host,
    selectedText: row.selected_text,
    anchorChunks,
    contextChunks,
    semanticChunks,
    selectionRect,
    ocrText: row.ocr_text,
    mergedText: row.merged_text,
    captureType: row.capture_type,
    userNote: row.user_note,
    tags: parseJson<string[]>(row.tags_json, []),
    images: parseJson<Scrap['images']>(row.images_json, []),
    screenshot: parseJson<Scrap['screenshot']>(row.screenshot_json, null),
    metadata,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function draftFromRow(row: DraftRow): WikiDraft {
  return {
    id: row.id,
    notionPageId: row.notion_page_id,
    title: row.title,
    topic: row.topic,
    mode: row.mode,
    status: row.status,
    summary: row.summary,
    keyConcepts: parseJson<string[]>(row.key_concepts_json, []),
    claims: parseJson<WikiDraft['claims']>(row.claims_json, []),
    openQuestions: parseJson<string[]>(row.open_questions_json, []),
    sections: parseJson<WikiDraft['sections']>(row.sections_json, []),
    scrapIds: parseJson<string[]>(row.scrap_ids_json, []),
    sourceLinks: parseJson<WikiDraft['sourceLinks']>(row.source_links_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function upsertScrap(input: Omit<Scrap, 'createdAt' | 'updatedAt'>) {
  const db = ensureDb()
  const existing = db.prepare('SELECT created_at FROM scraps WHERE id = ?').get(input.id) as { created_at: string } | undefined
  const timestamp = nowIso()
  const metadata = {
    ...input.metadata,
    anchorChunks: input.anchorChunks,
    contextChunks: input.contextChunks,
    semanticChunks: input.semanticChunks,
    selectionRect: input.selectionRect
  }

  db.prepare(`
    INSERT INTO scraps (
      id, notion_page_id, title, page_title, source_url, source_host, selected_text, ocr_text, merged_text,
      capture_type, user_note, tags_json, images_json, screenshot_json, metadata_json, captured_at, created_at, updated_at
    ) VALUES (
      @id, @notion_page_id, @title, @page_title, @source_url, @source_host, @selected_text, @ocr_text, @merged_text,
      @capture_type, @user_note, @tags_json, @images_json, @screenshot_json, @metadata_json, @captured_at, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      notion_page_id = excluded.notion_page_id,
      title = excluded.title,
      page_title = excluded.page_title,
      source_url = excluded.source_url,
      source_host = excluded.source_host,
      selected_text = excluded.selected_text,
      ocr_text = excluded.ocr_text,
      merged_text = excluded.merged_text,
      capture_type = excluded.capture_type,
      user_note = excluded.user_note,
      tags_json = excluded.tags_json,
      images_json = excluded.images_json,
      screenshot_json = excluded.screenshot_json,
      metadata_json = excluded.metadata_json,
      captured_at = excluded.captured_at,
      updated_at = excluded.updated_at
  `).run({
    id: input.id,
    notion_page_id: input.notionPageId,
    title: input.title,
    page_title: input.pageTitle,
    source_url: input.sourceUrl,
    source_host: input.sourceHost,
    selected_text: input.selectedText,
    ocr_text: input.ocrText,
    merged_text: input.mergedText,
    capture_type: input.captureType,
    user_note: input.userNote,
    tags_json: JSON.stringify(input.tags),
    images_json: JSON.stringify(input.images),
    screenshot_json: input.screenshot ? JSON.stringify(input.screenshot) : null,
    metadata_json: JSON.stringify(metadata),
    captured_at: input.capturedAt,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp
  })
  return getScrap(input.id)
}

export function getScrap(id: string) {
  const db = ensureDb()
  const row = db.prepare('SELECT * FROM scraps WHERE id = ?').get(id) as ScrapRow | undefined
  return row ? scrapFromRow(row) : null
}

export function listScraps(limit = 200) {
  const db = ensureDb()
  const rows = db.prepare(`
    SELECT *
    FROM scraps
    ORDER BY captured_at DESC, updated_at DESC
    LIMIT ?
  `).all(limit) as ScrapRow[]
  return rows.map(scrapFromRow)
}

export function listScrapSummaries(limit = 200): ScrapSummary[] {
  return listScraps(limit).map((scrap) => ({
    id: scrap.id,
    title: scrap.title,
    sourceHost: scrap.sourceHost,
    sourceUrl: scrap.sourceUrl,
    captureType: scrap.captureType,
    summary: scrap.mergedText.slice(0, 260),
    tags: scrap.tags,
    imageCount: scrap.images.length + (scrap.screenshot ? 1 : 0),
    semanticChunkCount: scrap.semanticChunks.length,
    capturedAt: scrap.capturedAt
  }))
}

export function summarizeScrap(scrap: Scrap): ScrapSummary {
  return {
    id: scrap.id,
    title: scrap.title,
    sourceHost: scrap.sourceHost,
    sourceUrl: scrap.sourceUrl,
    captureType: scrap.captureType,
    summary: scrap.mergedText.slice(0, 260),
    tags: scrap.tags,
    imageCount: scrap.images.length + (scrap.screenshot ? 1 : 0),
    semanticChunkCount: scrap.semanticChunks.length,
    capturedAt: scrap.capturedAt
  }
}

export function searchScrapDetails(query: string, limit = 10, tags: string[] = []) {
  const db = ensureDb()
  const wildcard = `%${query.toLowerCase()}%`
  const rows = db.prepare(`
    SELECT *
    FROM scraps
    WHERE lower(title) LIKE ?
      OR lower(page_title) LIKE ?
      OR lower(merged_text) LIKE ?
      OR lower(user_note) LIKE ?
      OR lower(source_host) LIKE ?
    ORDER BY captured_at DESC
    LIMIT ?
  `).all(wildcard, wildcard, wildcard, wildcard, wildcard, limit * 3) as ScrapRow[]
  const normalizedTags = tags.map((tag) => tag.toLowerCase())
  return rows
    .map(scrapFromRow)
    .filter((scrap) => normalizedTags.length === 0 || normalizedTags.every((tag) => scrap.tags.map((item) => item.toLowerCase()).includes(tag)))
    .slice(0, limit)
}

export function searchScraps(query: string, limit = 10, tags: string[] = []): ScrapSummary[] {
  return searchScrapDetails(query, limit, tags).map(summarizeScrap)
}

export function deleteScraps(ids: string[]) {
  if (ids.length === 0) return 0
  const db = ensureDb()
  const placeholders = ids.map(() => '?').join(', ')
  const result = db.prepare(`DELETE FROM scraps WHERE id IN (${placeholders})`).run(...ids)
  return result.changes
}

export function createWikiDraft(input: Omit<WikiDraft, 'createdAt' | 'updatedAt' | 'status' | 'notionPageId'> & { status?: WikiDraftStatus; notionPageId?: string | null }) {
  const db = ensureDb()
  const timestamp = nowIso()
  db.prepare(`
    INSERT INTO wiki_drafts (
      id, notion_page_id, title, topic, mode, status, summary, key_concepts_json, claims_json,
      open_questions_json, sections_json, scrap_ids_json, source_links_json, created_at, updated_at
    ) VALUES (
      @id, @notion_page_id, @title, @topic, @mode, @status, @summary, @key_concepts_json, @claims_json,
      @open_questions_json, @sections_json, @scrap_ids_json, @source_links_json, @created_at, @updated_at
    )
  `).run({
    id: input.id,
    notion_page_id: input.notionPageId ?? null,
    title: input.title,
    topic: input.topic,
    mode: input.mode,
    status: input.status ?? 'draft',
    summary: input.summary,
    key_concepts_json: JSON.stringify(input.keyConcepts),
    claims_json: JSON.stringify(input.claims),
    open_questions_json: JSON.stringify(input.openQuestions),
    sections_json: JSON.stringify(input.sections),
    scrap_ids_json: JSON.stringify(input.scrapIds),
    source_links_json: JSON.stringify(input.sourceLinks),
    created_at: timestamp,
    updated_at: timestamp
  })
  return getWikiDraft(input.id)
}

export function getWikiDraft(id: string) {
  const db = ensureDb()
  const row = db.prepare('SELECT * FROM wiki_drafts WHERE id = ?').get(id) as DraftRow | undefined
  return row ? draftFromRow(row) : null
}

export function listWikiDrafts(limit = 200) {
  const db = ensureDb()
  const rows = db.prepare(`
    SELECT *
    FROM wiki_drafts
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as DraftRow[]
  return rows.map(draftFromRow)
}

export function listWikiDraftSummaries(limit = 200): WikiDraftSummary[] {
  return listWikiDrafts(limit).map((draft) => ({
    id: draft.id,
    title: draft.title,
    topic: draft.topic,
    mode: draft.mode,
    status: draft.status,
    summary: draft.summary,
    scrapCount: draft.scrapIds.length,
    updatedAt: draft.updatedAt
  }))
}

export function summarizeWikiDraft(draft: WikiDraft): WikiDraftSummary {
  return {
    id: draft.id,
    title: draft.title,
    topic: draft.topic,
    mode: draft.mode,
    status: draft.status,
    summary: draft.summary,
    scrapCount: draft.scrapIds.length,
    updatedAt: draft.updatedAt
  }
}

export function searchWikiDraftDetails(query: string, limit = 10) {
  const db = ensureDb()
  const wildcard = `%${query.toLowerCase()}%`
  const rows = db.prepare(`
    SELECT *
    FROM wiki_drafts
    WHERE lower(title) LIKE ?
      OR lower(topic) LIKE ?
      OR lower(summary) LIKE ?
      OR lower(key_concepts_json) LIKE ?
      OR lower(claims_json) LIKE ?
      OR lower(sections_json) LIKE ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, limit) as DraftRow[]
  return rows.map(draftFromRow)
}

export function searchWikiDrafts(query: string, limit = 10): WikiDraftSummary[] {
  return searchWikiDraftDetails(query, limit).map(summarizeWikiDraft)
}

export function updateWikiDraftStatus(id: string, status: WikiDraftStatus, notionPageId?: string | null) {
  const db = ensureDb()
  db.prepare(`
    UPDATE wiki_drafts
    SET status = ?, notion_page_id = COALESCE(?, notion_page_id), updated_at = ?
    WHERE id = ?
  `).run(status, notionPageId ?? null, nowIso(), id)
  return getWikiDraft(id)
}
