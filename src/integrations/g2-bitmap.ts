/** 16px Japanese text, split to the SDK's maximum 288×144 image containers.
 * PNG encoding lets the native host perform its documented greyscale conversion.
 * Returns null where Canvas is unavailable so ordinary text remains usable.
 */
export function renderGlassesBitmap(content: string): [Uint8Array, Uint8Array] | null {
  try {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas'); canvas.width = 576; canvas.height = 144
    const context = canvas.getContext('2d'); if (!context) return null
    context.fillStyle = '#000'; context.fillRect(0, 0, 576, 144)
    context.fillStyle = '#fff'; context.font = '16px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif'
    context.textBaseline = 'top'
    const lines = content.replace(/\r/g, '').split('\n').slice(0, 4)
    const drawLine = (line: string, left: number, top: number) => {
      let text = line.replace(/\s+/g, ' ').trim()
      if (context.measureText(text).width > 560) {
        const characters = Array.from(text)
        while (characters.length && context.measureText(`${characters.join('')}…`).width > 560) characters.pop()
        text = `${characters.join('')}…`
      }
      context.fillText(text, left, top)
    }
    for (const [index, line] of lines.entries()) {
      const separator = line.indexOf(' 問:')
      drawLine(separator < 0 ? line : line.slice(0, separator), 8, 4 + index * 34)
      if (separator >= 0) drawLine(line.slice(separator + 1), 8, 21 + index * 34)
    }
    const tiles = [0, 288].map(left => {
      const tile = document.createElement('canvas'); tile.width = 288; tile.height = 144
      const tileContext = tile.getContext('2d'); if (!tileContext) throw new Error('canvas_unavailable')
      tileContext.drawImage(canvas, left, 0, 288, 144, 0, 0, 288, 144)
      const encoded = tile.toDataURL('image/png').split(',')[1]
      if (!encoded) throw new Error('png_unavailable')
      return Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    })
    return [tiles[0]!, tiles[1]!]
  } catch { return null }
}
