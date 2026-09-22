import { afterEach, expect, it, vi } from 'vitest'
import { renderGlassesBitmap } from '../src/integrations/g2-bitmap.ts'

afterEach(() => vi.unstubAllGlobals())
it('keeps concise text at 16px and fits complete legacy text without ellipses in four fact/question pairs', () => {
  const draws: { text: string; x: number; y: number; fontSize: number; maxWidth: number }[] = []
  const contexts: { font: string }[] = []
  const canvases: { width: number; height: number }[] = []
  vi.stubGlobal('document', { createElement: () => {
    const context = { font: '', fillStyle: '', textBaseline: '', fillRect() {}, drawImage() {},
      measureText(text: string) { return { width: Array.from(text).length * Number.parseFloat(this.font) } },
      fillText(text: string, x: number, y: number, maxWidth: number) { draws.push({ text, x, y, maxWidth, fontSize: Number.parseFloat(this.font) }) },
    }
    contexts.push(context)
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,iVBORw==' }
    canvases.push(canvas); return canvas
  } })
  const longFact = '日本語😀'.repeat(30)
  const shortFact = 'あ'.repeat(28)
  const result = renderGlassesBitmap(Array.from({ length: 4 }, (_, index) => `${index + 1} 事:${index === 0 ? longFact : shortFact} 問:活動のきっかけは？`).join('\n'))
  expect(contexts[0]!.font.startsWith('16px ')).toBe(true)
  expect(draws).toHaveLength(8)
  for (const row of draws) {
    expect(row.x + Math.min(row.maxWidth, Array.from(row.text).length * row.fontSize)).toBeLessThanOrEqual(576)
    expect(row.y + row.fontSize).toBeLessThanOrEqual(144)
    expect(row.text).not.toContain('…')
  }
  expect(draws[0]!.text).toBe(`1 事:${longFact}`)
  expect(draws[0]!.fontSize).toBeLessThan(16)
  expect(draws[2]!.text).toBe(`2 事:${shortFact}`)
  expect(draws[2]!.fontSize).toBe(16)
  expect(canvases.map(({ width, height }) => [width, height])).toEqual([[576, 144], [288, 144], [288, 144]])
  expect(result?.map(bytes => [...bytes])).toEqual([[137, 80, 78, 71], [137, 80, 78, 71]])
})
