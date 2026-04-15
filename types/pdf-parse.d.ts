declare module 'pdf-parse/lib/pdf-parse' {
  export interface PDFParseResult {
    numpages: number
    numrender: number
    info?: Record<string, unknown>
    metadata?: Record<string, unknown>
    text: string
    version?: string
  }

  export default function pdf(
    dataBuffer: Buffer,
    options?: Record<string, unknown>
  ): Promise<PDFParseResult>
}
