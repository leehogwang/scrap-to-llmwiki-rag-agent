import path from 'path'
import { createId, upsertScrap } from '@/lib/server/db'
import { downloadRemoteFile, createScrapPageInNotion } from '@/lib/server/notion'
import { runOcr } from '@/lib/server/ocr'
import { enrichSmartScrap } from '@/lib/server/smart-scrap'
import { fetchYouTubeTranscript } from '@/lib/server/youtube'
import type { Scrap, ScrapAsset, ScrapCandidateChunk, ScrapImageCandidate, SelectionRect, YouTubeCaptureMeta } from '@/lib/types'

const MAX_IMAGE_COUNT = 6
const MAX_TEXT_LENGTH = 40000

function slugifyFilename(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'capture'
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function pickTitle(pageTitle: string, selectedText: string) {
  const cleanPageTitle = normalizeText(pageTitle)
  const cleanSelected = normalizeText(selectedText)
  if (cleanSelected) {
    return cleanSelected.slice(0, 90)
  }
  return cleanPageTitle.slice(0, 90) || 'Web scrap'
}

export async function captureScrapToNotion(input: {
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
  screenshot?: File | null
  rect?: SelectionRect
}) {
  // Normalize browser-captured payload into one canonical scrap record before handing it off to Notion + SQLite.
  const sourceUrl = input.youtubeMeta?.videoUrl ?? input.pageUrl
  const pageTitle = normalizeText(input.youtubeMeta?.videoTitle || input.pageTitle) || 'Untitled page'
  const sourceHost = (() => {
    try {
      return new URL(sourceUrl).host || input.sourceHost
    } catch {
      return input.sourceHost
    }
  })()
  const normalizedSelectedText = normalizeText(input.selectedText || input.youtubeMeta?.videoTitle || '').slice(0, MAX_TEXT_LENGTH)
  const screenshotBuffer = input.screenshot ? Buffer.from(await input.screenshot.arrayBuffer()) : null
  const ocrText = screenshotBuffer ? await runOcr(screenshotBuffer) : ''
  const smartScrap = enrichSmartScrap({
    selectedText: normalizedSelectedText || ocrText,
    candidateChunks: input.candidateChunks,
    imageCandidates: input.imageCandidates ?? [],
    selectionRect: input.rect ?? null
  })

  const transcript = input.youtubeMeta ? await fetchYouTubeTranscript(input.youtubeMeta.videoId) : { text: '', available: false, error: null as string | null }
  // Fold semantic context, optional transcript, and OCR into one merged body so downstream wiki generation reads a single source of truth.
  const mergedText = [smartScrap.mergedText, transcript.text, ocrText]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_TEXT_LENGTH)
  const selectedImageUrls = smartScrap.selectedImageUrls.length > 0
    ? smartScrap.selectedImageUrls
    : input.imageUrls
  const dedupedImageUrls = [...new Set([
    ...selectedImageUrls,
    ...(input.youtubeMeta?.thumbnailUrl ? [input.youtubeMeta.thumbnailUrl] : [])
  ])]
  const limitedImageUrls = dedupedImageUrls.slice(0, MAX_IMAGE_COUNT)
  const title = input.youtubeMeta?.videoTitle
    ? normalizeText(input.youtubeMeta.videoTitle).slice(0, 90)
    : pickTitle(pageTitle, mergedText || normalizedSelectedText)
  const capturedAt = new Date().toISOString()

  const images: ScrapAsset[] = []
  const notionImageFiles: Array<{ buffer: Buffer; filename: string; mimeType: string; sourceUrl: string | null; caption: string }> = []
  for (const [index, imageUrl] of limitedImageUrls.entries()) {
    try {
      const download = await downloadRemoteFile(imageUrl)
      const filename = slugifyFilename(download.filename || `image-${index + 1}${path.extname(new URL(imageUrl).pathname)}`)
      images.push({
        id: createId('img'),
        filename,
        mimeType: download.mimeType,
        sourceUrl: imageUrl,
        notionFileId: null,
        status: 'uploaded',
        sizeBytes: download.sizeBytes,
        caption: `Captured image ${index + 1}`
      })
      notionImageFiles.push({
        buffer: download.buffer,
        filename,
        mimeType: download.mimeType,
        sourceUrl: imageUrl,
        caption: `Captured image ${index + 1}`
      })
    } catch (error) {
      images.push({
        id: createId('img'),
        filename: `image-${index + 1}`,
        mimeType: 'application/octet-stream',
        sourceUrl: imageUrl,
        notionFileId: null,
        status: 'failed',
        sizeBytes: 0,
        error: error instanceof Error ? error.message : 'Image download failed'
      })
    }
  }

  const screenshotAsset: ScrapAsset | null = screenshotBuffer
    ? {
        id: createId('shot'),
        filename: slugifyFilename(`${title}-region.png`),
        mimeType: input.screenshot?.type || 'image/png',
        sourceUrl: input.pageUrl,
        notionFileId: null,
        status: 'uploaded',
        sizeBytes: screenshotBuffer.byteLength,
        caption: 'Captured region screenshot'
      }
    : null

  const notionResult = await createScrapPageInNotion({
    title,
    pageTitle,
    sourceUrl,
    sourceHost,
    ocrText,
    mergedText,
    captureType:
      normalizedSelectedText && images.length > 0
        ? 'dom+images'
        : normalizedSelectedText && ocrText
          ? 'mixed'
          : normalizedSelectedText
            ? 'dom'
            : 'ocr',
    tags: input.tags ?? [],
    userNote: input.userNote?.trim() ?? '',
    capturedAt,
    selectionRect: smartScrap.selectionRect,
    imageFiles: notionImageFiles,
    youtubeMeta: input.youtubeMeta,
    transcriptText: transcript.text,
    transcriptStatus: transcript.available ? 'available' : transcript.error ? 'unavailable' : 'not_requested',
    screenshotFile: screenshotBuffer && screenshotAsset
      ? {
          buffer: screenshotBuffer,
          filename: screenshotAsset.filename,
          mimeType: screenshotAsset.mimeType,
          caption: screenshotAsset.caption ?? 'Captured region screenshot'
        }
      : null
  })

  const notionImageIdQueue = [...notionResult.imageFileIds]
  const hydratedImages = images.map((image) =>
    image.status === 'uploaded'
      ? { ...image, notionFileId: notionImageIdQueue.shift() ?? null }
      : image
  )
  const hydratedScreenshot = screenshotAsset
    ? { ...screenshotAsset, notionFileId: notionResult.screenshotFileId }
    : null

  // Mirror the Notion page into the local database so later RAG/graph rebuilds can run offline from persisted state.
  const scrap = upsertScrap({
    id: createId('scrap'),
    notionPageId: notionResult.pageId,
    title,
    pageTitle,
    sourceUrl,
    sourceHost,
    selectedText: normalizedSelectedText,
    anchorChunks: [],
    contextChunks: [],
    semanticChunks: [],
    selectionRect: smartScrap.selectionRect,
    ocrText,
    mergedText,
    captureType:
      normalizedSelectedText && hydratedImages.length > 0
        ? 'dom+images'
        : normalizedSelectedText && ocrText
          ? 'mixed'
          : normalizedSelectedText
            ? 'dom'
            : 'ocr',
    userNote: input.userNote?.trim() ?? '',
    tags: input.tags ?? [],
    images: hydratedImages,
    screenshot: hydratedScreenshot,
    metadata: {
      rect: input.rect ?? null,
      imageUrls: limitedImageUrls,
      youtube: input.youtubeMeta
        ? {
            ...input.youtubeMeta,
            transcriptAvailable: transcript.available,
            transcriptStatus: transcript.available ? 'available' : 'unavailable',
            transcriptError: transcript.error
          }
        : null
    },
    capturedAt
  })

  if (!scrap) {
    throw new Error('Failed to persist scrap locally')
  }

  return scrap
}
