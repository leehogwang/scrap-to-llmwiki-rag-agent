import { NextRequest, NextResponse } from 'next/server'
import { getScrap } from '@/lib/server/db'

export const runtime = 'nodejs'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const scrap = getScrap(id)
  if (!scrap) {
    return NextResponse.json({ error: 'Scrap not found' }, { status: 404 })
  }
  return NextResponse.json({ scrap })
}
