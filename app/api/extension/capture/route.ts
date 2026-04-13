import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { captureScrapToNotion } from '@/lib/server/capture'

export const runtime = 'nodejs'

const payloadSchema = z.object({
  pageUrl: z.string().url(),
  pageTitle: z.string().min(1).max(1000),
  sourceHost: z.string().min(1).max(500),
  selectedText: z.string().max(120000).default(''),
  candidateChunks: z.array(z.object({
    id: z.string().min(1).max(500),
    text: z.string().min(1).max(12000),
    nearestHeading: z.string().max(2000).default(''),
    positionIndex: z.number().int().nonnegative(),
    intersectsSelection: z.boolean(),
    domPath: z.string().max(2000),
    containerPath: z.string().max(2000),
    top: z.number().optional(),
    bottom: z.number().optional()
  })).max(500).default([]),
  imageUrls: z.array(z.string().url()).max(64).default([]),
  imageCandidates: z.array(z.object({
    id: z.string().min(1).max(500),
    sourceUrl: z.string().url(),
    nearestHeading: z.string().max(2000).default(''),
    positionIndex: z.number().int().nonnegative(),
    intersectsSelection: z.boolean(),
    top: z.number(),
    bottom: z.number(),
    width: z.number(),
    height: z.number()
  })).max(256).default([]),
  userNote: z.string().max(10000).optional(),
  tags: z.array(z.string().max(120)).max(50).optional(),
  rect: z.object({
    left: z.number(),
    top: z.number(),
    width: z.number(),
    height: z.number(),
    scrollX: z.number().optional(),
    scrollY: z.number().optional(),
    devicePixelRatio: z.number().optional()
  }).optional()
})

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const rawPayload = formData.get('payload')
    if (typeof rawPayload !== 'string') {
      throw new Error('Missing capture payload')
    }
    const parsed = payloadSchema.parse(JSON.parse(rawPayload))
    const screenshot = formData.get('screenshot')
    const scrap = await captureScrapToNotion({
      ...parsed,
      screenshot: screenshot instanceof File ? screenshot : null
    })
    return NextResponse.json({ scrap })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to capture scrap' },
      { status: 400 }
    )
  }
}
