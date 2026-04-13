import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ClipWiki',
  description: 'Chrome scrap to Notion LLM-Wiki for study notes, claim comparison, and personal knowledge curation.'
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang='ko'>
      <body>{children}</body>
    </html>
  )
}
