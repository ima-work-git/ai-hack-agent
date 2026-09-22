import { afterEach, expect, it, vi } from 'vitest'
import { renderGlassesBitmap } from '../src/integrations/g2-bitmap.ts'

afterEach(() => vi.unstubAllGlobals())
it('draws four fact/question pairs in 16px within 576×144 and emits two bounded PNG tiles', () => {
  const draws: { text: string; x: number; y: number }[] = []
  const contexts: { font: string }[] = []
  const canvases: { width: number; height: number }[] = []
  vi.stubGlobal('document', { createElement: () => {
    const context = { font: '', fillStyle: '', textBaseline: '', fillRect() {}, drawImage() {},
      measureText: (text: string) => ({ width: Array.from(text).length * 16 }),
      fillText: (text: string, x: number, y: number) => draws.push({ text, x, y }),
    }
    contexts.push(context)
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,iVBORw==' }
    canvases.push(canvas); return canvas
  } })
  const result = renderGlassesBitmap(Array.from({ length: 4 }, (_, index) => `${index + 1} 事:${'日本語😀'.repeat(30)} 問:活動のきっかけは？`).join('\n'))
  expect(contexts[0]!.font.startsWith('16px ')).toBe(true)
  expect(draws).toHaveLength(8)
  for (const row of draws) {
    expect(row.x + Array.from(row.text).length * 16).toBeLessThanOrEqual(576)
    expect(row.y + 16).toBeLessThanOrEqual(144)
  }
  expect(draws[0]!.text.endsWith('…')).toBe(true)
  expect(canvases.map(({ width, height }) => [width, height])).toEqual([[576, 144], [288, 144], [288, 144]])
  expect(result?.map(bytes => [...bytes])).toEqual([[137, 80, 78, 71], [137, 80, 78, 71]])
})
