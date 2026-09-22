import { afterEach, expect, it, vi } from 'vitest'
import { renderGlassesBitmap } from '../src/integrations/g2-bitmap.ts'

afterEach(() => vi.unstubAllGlobals())
function canvasFixture() {
  const draws: { text: string; x: number; y: number; fontSize: number }[] = []
  const canvases: { width: number; height: number }[] = []
  vi.stubGlobal('document', { createElement: () => {
    const context = { font: '', fillStyle: '', textBaseline: '', fillRect() {}, drawImage() {},
      measureText(text: string) { return { width: Array.from(text).length * Number.parseFloat(this.font) } },
      fillText(text: string, x: number, y: number) { draws.push({ text, x, y, fontSize: Number.parseFloat(this.font) }) },
    }
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,iVBORw==' }
    canvases.push(canvas); return canvas
  } })
  return { draws, canvases }
}

it('renders all four current fact/question pairs and their paragraph gaps at 14px without slicing lines', () => {
  const { draws, canvases } = canvasFixture()
  const content = Array.from({ length: 4 }, (_, i) => `${i + 1} 最近X 事実:公開の事実です。\n⭐️推奨質問：活動のきっかけは？`).join('\n\n')
  const result = renderGlassesBitmap(content)
  expect(draws).toHaveLength(8)
  expect(draws.map(row => row.text)).toEqual(content.split('\n').filter(Boolean))
  for (const row of draws) {
    expect(row.fontSize).toBe(14)
    expect(row.x + Array.from(row.text).length * row.fontSize).toBeLessThanOrEqual(568)
    expect(row.y + row.fontSize).toBeLessThanOrEqual(142)
    expect(row.text).not.toContain('…')
  }
  expect(draws[2]!.y - draws[1]!.y).toBe(20)
  expect(canvases.map(({ width, height }) => [width, height])).toEqual([[576, 144], [288, 144], [288, 144]])
  expect(result?.map(bytes => [...bytes])).toEqual([[137, 80, 78, 71], [137, 80, 78, 71]])
})

it('renders every line of the six-line excerpt page, including its final characters', () => {
  const { draws } = canvasFixture()
  const lines = Array.from({ length: 6 }, (_, i) => `${i + 1}行目の出典です。`).concat([])
  expect(renderGlassesBitmap(lines.join('\n'))).not.toBeNull()
  expect(draws.map(row => row.text)).toEqual(lines)
})

it('wraps complete text at 14px without horizontal squeezing or splitting a grapheme', () => {
  const { draws } = canvasFixture()
  const content = 'あ'.repeat(39) + '⭐️続き😀です'
  expect(renderGlassesBitmap(content)).not.toBeNull()
  expect(draws.length).toBeGreaterThan(1)
  expect(draws.map(row => row.text).join('')).toBe(content)
  expect(draws.every(row => row.fontSize === 14)).toBe(true)
  expect(draws[1]!.text.startsWith('⭐️')).toBe(true)
})

it('returns null before painting any text when complete content cannot fit, so native scrolling can preserve it', () => {
  const { draws } = canvasFixture()
  expect(renderGlassesBitmap(Array.from({ length: 12 }, () => '省略しない出典の長文です').join('\n'))).toBeNull()
  expect(draws).toHaveLength(0)
  expect(renderGlassesBitmap('長い出典'.repeat(200))).toBeNull()
  expect(draws).toHaveLength(0)
})

it('returns null when Canvas is unavailable or content is empty', () => {
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) })
  expect(renderGlassesBitmap('全文')).toBeNull()
  canvasFixture()
  expect(renderGlassesBitmap('\n  \n')).toBeNull()
})
