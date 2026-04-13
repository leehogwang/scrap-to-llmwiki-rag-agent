import Tesseract from 'tesseract.js'

export async function runOcr(buffer: Buffer) {
  const result = await Tesseract.recognize(buffer, 'eng+kor', {
    logger: () => {}
  })
  return result.data.text.replace(/\s+/g, ' ').trim()
}
