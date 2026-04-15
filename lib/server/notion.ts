import { Client } from '@notionhq/client'
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints'
import { getRequiredEnv, getOptionalEnv } from '@/lib/server/env'
import { youtubeMetadataSummary } from '@/lib/server/youtube'
import type { Scrap, ScrapAsset, SelectionRect, WikiDraft, YouTubeCaptureMeta } from '@/lib/types'

const NOTION_VERSION = '2026-03-11'
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

function notionClient() {
  return new Client({ auth: getRequiredEnv('NOTION_API_KEY') })
}

function notionHeaders(contentType?: string) {
  return {
    Authorization: `Bearer ${getRequiredEnv('NOTION_API_KEY')}`,
    'Notion-Version': NOTION_VERSION,
    ...(contentType ? { 'Content-Type': contentType } : {})
  }
}

function truncateText(text: string, limit = 1800) {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text
}

function paragraphBlock(text: string): BlockObjectRequest {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: truncateText(text, 1800) } }]
    }
  }
}

function headingBlock(text: string, level: 1 | 2 | 3 = 2): BlockObjectRequest {
  return {
    object: 'block',
    type: `heading_${level}`,
    [`heading_${level}`]: {
      rich_text: [{ type: 'text', text: { content: truncateText(text, 200) } }]
    }
  } as BlockObjectRequest
}

function bulletedBlock(text: string): BlockObjectRequest {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: [{ type: 'text', text: { content: truncateText(text, 1800) } }]
    }
  }
}

function linkParagraphBlock(label: string, url: string): BlockObjectRequest {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: `${label}: ` } },
        { type: 'text', text: { content: truncateText(url, 1800), link: { url } } }
      ]
    }
  }
}

function normalizeKey(key: string) {
  return key.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function uploadFileToNotion(buffer: Buffer, filename: string, mimeType: string) {
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds Notion direct upload limit (${filename})`)
  }

  const createResponse = await fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST',
    headers: notionHeaders('application/json'),
    body: JSON.stringify({})
  })

  if (!createResponse.ok) {
    throw new Error(`Failed to create Notion file upload (${createResponse.status})`)
  }

  const createPayload = await createResponse.json() as { id: string; upload_url: string }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename)

  const sendResponse = await fetch(createPayload.upload_url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getRequiredEnv('NOTION_API_KEY')}`,
      'Notion-Version': NOTION_VERSION
    },
    body: form
  })

  if (!sendResponse.ok) {
    throw new Error(`Failed to send Notion file upload (${sendResponse.status})`)
  }

  return createPayload.id
}

function imageBlock(fileUploadId: string, caption: string): BlockObjectRequest {
  return {
    object: 'block',
    type: 'image',
    image: {
      type: 'file_upload',
      file_upload: { id: fileUploadId },
      caption: caption
        ? [{ type: 'text', text: { content: truncateText(caption, 200) } }]
        : []
    }
  } as unknown as BlockObjectRequest
}

async function fetchDatabaseSchema(databaseId: string) {
  const client = notionClient()
  const database = await client.databases.retrieve({ database_id: databaseId }) as Record<string, any>
  const properties = database.properties ?? {}
  const titleEntry = Object.entries(properties).find(([, value]) => (value as any)?.type === 'title')
  if (!titleEntry) {
    throw new Error('Could not find a title property in the Notion scrap database')
  }

  const optionalProperties = new Map<string, { name: string; type: string }>()
  for (const [name, value] of Object.entries(properties) as Array<[string, any]>) {
    optionalProperties.set(normalizeKey(name), { name, type: value.type })
  }

  return {
    titlePropertyName: titleEntry[0],
    optionalProperties
  }
}

function buildPropertyAssignments(input: {
  title: string
  pageTitle: string
  sourceUrl: string
  sourceHost: string
  ocrText: string
  mergedText: string
  captureType: Scrap['captureType']
  tags: string[]
  userNote: string
  capturedAt: string
  imageFileIds: string[]
  screenshotFileId: string | null
}) {
  return async (databaseId: string) => {
    const schema = await fetchDatabaseSchema(databaseId)
    // Resolve property names dynamically so the integration survives user-side column renames in Notion.
    const properties: Record<string, any> = {
      [schema.titlePropertyName]: {
        title: [{ type: 'text', text: { content: truncateText(input.title, 180) } }]
      }
    }

    const trySet = (label: string, value: unknown) => {
      const property = schema.optionalProperties.get(normalizeKey(label))
      if (!property) return

      if (property.type === 'url' && typeof value === 'string') {
        properties[property.name] = { url: value }
      } else if (property.type === 'rich_text' && typeof value === 'string') {
        properties[property.name] = {
          rich_text: value
            ? [{ type: 'text', text: { content: truncateText(value, 1800) } }]
            : []
        }
      } else if (property.type === 'multi_select' && Array.isArray(value)) {
        properties[property.name] = { multi_select: value.map((item) => ({ name: String(item) })) }
      } else if ((property.type === 'select' || property.type === 'status') && typeof value === 'string' && value) {
        properties[property.name] = { [property.type]: { name: value } }
      } else if (property.type === 'date' && typeof value === 'string') {
        properties[property.name] = { date: { start: value } }
      } else if (property.type === 'files' && Array.isArray(value)) {
        properties[property.name] = {
          files: value.map((fileId, index) => ({
            type: 'file_upload',
            name: `attachment-${index + 1}`,
            file_upload: { id: String(fileId) }
          }))
        }
      }
    }

    trySet('Page Title', input.pageTitle)
    trySet('Source URL', input.sourceUrl)
    trySet('Source Host', input.sourceHost)
    trySet('OCR Text', input.ocrText)
    trySet('Merged Text', input.mergedText)
    trySet('Capture Type', input.captureType)
    trySet('Tags', input.tags)
    trySet('User Note', input.userNote)
    trySet('Captured At', input.capturedAt)
    trySet('Images', input.imageFileIds)
    trySet('Region Screenshot', input.screenshotFileId ? [input.screenshotFileId] : [])
    trySet('Status', 'captured')

    return properties
  }
}

export async function createScrapPageInNotion(input: {
  title: string
  pageTitle: string
  sourceUrl: string
  sourceHost: string
  ocrText: string
  mergedText: string
  transcriptText?: string
  transcriptStatus?: 'available' | 'unavailable' | 'not_requested'
  youtubeMeta?: YouTubeCaptureMeta
  captureType: Scrap['captureType']
  tags: string[]
  userNote: string
  capturedAt: string
  selectionRect?: SelectionRect | null
  imageFiles: Array<{ buffer: Buffer; filename: string; mimeType: string; sourceUrl: string | null; caption: string }>
  screenshotFile?: { buffer: Buffer; filename: string; mimeType: string; caption: string } | null
}) {
  // Create the structured database row first, then append richer block content (links, transcript, images) below it.
  const client = notionClient()
  const databaseId = getRequiredEnv('NOTION_SCRAP_DATABASE_ID')

  const imageFileIds: string[] = []
  for (const file of input.imageFiles) {
    imageFileIds.push(await uploadFileToNotion(file.buffer, file.filename, file.mimeType))
  }

  const screenshotFileId = input.screenshotFile
    ? await uploadFileToNotion(input.screenshotFile.buffer, input.screenshotFile.filename, input.screenshotFile.mimeType)
    : null

  const properties = await buildPropertyAssignments({
    title: input.title,
    pageTitle: input.pageTitle,
    sourceUrl: input.sourceUrl,
    sourceHost: input.sourceHost,
    ocrText: input.ocrText,
    mergedText: input.mergedText,
    captureType: input.captureType,
    tags: input.tags,
    userNote: input.userNote,
    capturedAt: input.capturedAt,
    imageFileIds,
    screenshotFileId
  })(databaseId)

  const children: BlockObjectRequest[] = [
    headingBlock('Source', 2),
    linkParagraphBlock('Original page', input.sourceUrl),
    paragraphBlock(`Source host: ${input.sourceHost}`),
    headingBlock('Merged text', 2),
    paragraphBlock(input.mergedText || '(No text captured)'),
    headingBlock('OCR text', 2),
    paragraphBlock(input.ocrText || '(No OCR text captured)'),
    headingBlock('Original image URLs', 2),
    ...(input.imageFiles.length > 0
      ? input.imageFiles.map((file) => bulletedBlock(file.sourceUrl ?? file.filename))
      : [paragraphBlock('(No image URLs captured)')])
  ]

  if (input.youtubeMeta) {
    children.push(headingBlock('YouTube video', 2))
    children.push(paragraphBlock(youtubeMetadataSummary(input.youtubeMeta)))
    children.push(headingBlock('YouTube transcript', 2))
    children.push(
      paragraphBlock(
        input.transcriptText ||
          (input.transcriptStatus === 'unavailable'
            ? '(Transcript unavailable for this video)'
            : '(No YouTube transcript captured)')
      )
    )
  }

  if (input.userNote) {
    children.push(headingBlock('User note', 2))
    children.push(paragraphBlock(input.userNote))
  }

  const page = await client.pages.create({
    parent: { database_id: databaseId },
    properties,
    children
  }) as Record<string, any>

  const extraBlocks: BlockObjectRequest[] = []
  imageFileIds.forEach((id, index) => {
    extraBlocks.push(imageBlock(id, input.imageFiles[index]?.caption ?? 'Captured image'))
  })
  if (screenshotFileId) {
    extraBlocks.push(imageBlock(screenshotFileId, input.screenshotFile?.caption ?? 'Captured region screenshot'))
  }

  if (extraBlocks.length > 0) {
    await client.blocks.children.append({
      block_id: page.id,
      children: extraBlocks
    })
  }

  return {
    pageId: page.id as string,
    imageFileIds,
    screenshotFileId
  }
}

export async function publishWikiDraftToNotion(draft: WikiDraft, scraps: Scrap[]) {
  const client = notionClient()
  const parentPageId = getOptionalEnv('NOTION_WIKI_ROOT_PAGE_ID', getOptionalEnv('NOTION_OUTPUT_ROOT_PAGE_ID'))
  if (!parentPageId) {
    throw new Error('Missing NOTION_WIKI_ROOT_PAGE_ID')
  }

  const children: BlockObjectRequest[] = [
    paragraphBlock(draft.summary),
    headingBlock('핵심 개념', 2),
    ...(draft.keyConcepts.length > 0 ? draft.keyConcepts.map((item) => bulletedBlock(item)) : [paragraphBlock('(추출된 개념이 없습니다)')]),
    headingBlock('주요 주장과 메모', 2),
    ...(draft.claims.length > 0
      ? draft.claims.flatMap((claim) => [
          bulletedBlock(`${claim.claim} [${claim.supportLevel}]`),
          ...claim.evidence.slice(0, 3).map((evidence) => paragraphBlock(`근거: ${evidence}`))
        ])
      : [paragraphBlock('(정리된 주장 분석이 없습니다)')]),
    ...draft.sections.flatMap((section) => [
      headingBlock(section.heading, 2),
      ...section.paragraphs.map((paragraph) => paragraphBlock(paragraph)),
      ...section.bullets.map((bullet) => bulletedBlock(bullet))
    ]),
    headingBlock('열린 질문', 2),
    ...(draft.openQuestions.length > 0 ? draft.openQuestions.map((item) => bulletedBlock(item)) : [paragraphBlock('(열린 질문이 없습니다)')]),
    headingBlock('연결된 스크랩', 2),
    ...scraps.map((scrap) => bulletedBlock(`${scrap.title} — ${scrap.sourceUrl}`)),
    headingBlock('출처 링크', 2),
    ...draft.sourceLinks.map((source) => bulletedBlock(`${source.title} — ${source.url}`))
  ]

  const page = await client.pages.create({
    parent: {
      type: 'page_id',
      page_id: parentPageId
    },
    properties: {
      title: {
        title: [{ type: 'text', text: { content: truncateText(draft.title, 180) } }]
      }
    },
    children
  }) as Record<string, any>

  return {
    pageId: page.id as string,
    url: (page.url as string | null) ?? null
  }
}

export async function archiveNotionPage(pageId: string) {
  const client = notionClient()

  try {
    await client.pages.update({
      page_id: pageId,
      archived: true
    } as any)
    return
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.toLowerCase().includes('archived')) {
      throw error
    }
  }

  await client.pages.update({
    page_id: pageId,
    in_trash: true
  } as any)
}

export async function downloadRemoteFile(url: string) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https image URLs are allowed')
  }

  const response = await fetch(url, {
    headers: { 'User-Agent': 'ClipWiki/0.1 (+capture)' },
    redirect: 'follow'
  })
  if (!response.ok) {
    throw new Error(`Failed to download file (${response.status})`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
  const dispositionName = response.headers.get('content-disposition')?.match(/filename="?([^"]+)"?/)?.[1] ?? null
  const pathnameName = parsed.pathname.split('/').filter(Boolean).pop() || 'capture.bin'
  const filename = dispositionName ?? pathnameName

  return {
    buffer,
    filename,
    mimeType,
    sizeBytes: buffer.byteLength
  }
}
