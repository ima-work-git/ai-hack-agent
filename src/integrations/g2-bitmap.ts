const WIDTH = 576
const HEIGHT = 144
const INSET = 8
const FONT_SIZE = 14
const LINE_HEIGHT = 16
const PARAGRAPH_GAP = 4

/** One step smaller than the previous 16px bitmap text. Draw the whole supplied
 * question board or excerpt page; if 14px cannot fit, use native scrollable text.
 * The two PNG tiles obey SDK 0.0.12's 288×144 per-image maximum. */
export function renderGlassesBitmap(content: string): [Uint8Array, Uint8Array] | null {
  try {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT
    const context = canvas.getContext('2d'); if (!context) return null
    context.font = `${FONT_SIZE}px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`
    context.textBaseline = 'top'
    const rows: { text: string; top: number }[] = []
    const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })
    let top = 2
    let paragraphGap = false
    for (const original of content.replace(/\r/g, '').split('\n')) {
      const line = original.trim()
      if (!line) { if (rows.length) paragraphGap = true; continue }
      if (paragraphGap) { top += PARAGRAPH_GAP; paragraphGap = false }
      let text = ''
      const append = () => {
        if (top + FONT_SIZE > HEIGHT - 2) return false
        rows.push({ text, top }); top += LINE_HEIGHT; text = ''; return true
      }
      for (const { segment } of segmenter.segment(line)) {
        if (context.measureText(segment).width > WIDTH - INSET * 2) return null
        if (text && context.measureText(text + segment).width > WIDTH - INSET * 2 && !append()) return null
        text += segment
      }
      if (text && !append()) return null
    }
    if (!rows.length) return null
    context.fillStyle = '#000'; context.fillRect(0, 0, WIDTH, HEIGHT)
    context.fillStyle = '#fff'
    // No character slicing, ellipsis, horizontal squeezing, or sub-14px text.
    for (const row of rows) context.fillText(row.text, INSET, row.top)
    const tiles = [0, 288].map(left => {
      const tile = document.createElement('canvas'); tile.width = 288; tile.height = HEIGHT
      const tileContext = tile.getContext('2d'); if (!tileContext) throw new Error('canvas_unavailable')
      tileContext.drawImage(canvas, left, 0, 288, HEIGHT, 0, 0, 288, HEIGHT)
      const encoded = tile.toDataURL('image/png').split(',')[1]
      if (!encoded) throw new Error('png_unavailable')
      return Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    })
    return [tiles[0]!, tiles[1]!]
  } catch { return null }
}
