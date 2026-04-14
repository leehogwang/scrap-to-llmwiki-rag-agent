import type { YouTubeCaptureMeta } from '@/lib/types'

const MAX_TRANSCRIPT_LENGTH = 28000

function normalizeTranscript(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

export async function fetchYouTubeTranscript(videoId: string) {
  try {
    const transcriptModule = await import('youtube-transcript/dist/youtube-transcript.esm.js')
    const items = await transcriptModule.YoutubeTranscript.fetchTranscript(videoId)
    const text = normalizeTranscript(items.map((item: { text: string }) => item.text).join(' '))
    return {
      text: text.slice(0, MAX_TRANSCRIPT_LENGTH),
      available: Boolean(text),
      error: null as string | null
    }
  } catch (error) {
    return {
      text: '',
      available: false,
      error: error instanceof Error ? error.message : 'Transcript unavailable'
    }
  }
}

export function youtubeMetadataSummary(youtube: YouTubeCaptureMeta) {
  const lines = [
    `Mode: ${youtube.mode}`,
    `Video ID: ${youtube.videoId}`,
    `Video URL: ${youtube.videoUrl}`,
    `Title: ${youtube.videoTitle}`
  ]

  if (youtube.channelName) {
    lines.push(`Channel: ${youtube.channelName}`)
  }
  if (youtube.channelUrl) {
    lines.push(`Channel URL: ${youtube.channelUrl}`)
  }
  if (youtube.thumbnailUrl) {
    lines.push(`Thumbnail URL: ${youtube.thumbnailUrl}`)
  }
  if (youtube.referrerUrl && youtube.referrerUrl !== youtube.videoUrl) {
    lines.push(`Captured from: ${youtube.referrerUrl}`)
  }

  return lines.join('\n')
}
