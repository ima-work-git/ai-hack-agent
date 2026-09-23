import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../public/mirror.html', import.meta.url), 'utf8').replace(/<script[\s\S]*?<\/script>/, '')
const script = readFileSync(new URL('../public/mirror.js', import.meta.url), 'utf8')
const now = Date.UTC(2026, 8, 23)
let browser: Window
let frame: unknown
let offline: boolean
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now)
  browser = new Window({ url: 'http://localhost:4173/mirror.html' })
  browser.document.write(html)
  // Use one controllable clock for the browser's polling and retention timers.
  browser.setTimeout = globalThis.setTimeout as unknown as typeof browser.setTimeout
  browser.clearTimeout = globalThis.clearTimeout as unknown as typeof browser.clearTimeout
  browser.Date = Date
  offline = false
  frame = { view: { header: '架空の人物', content: '<img src=x onerror=alert(1)>', footer: '音声認識中' }, state: 'recording', updatedAt: now }
  browser.fetch = vi.fn(async () => {
    if (offline) throw new Error('offline')
    return { ok: true, json: async () => ({ frame }) }
  }) as unknown as typeof browser.fetch
  browser.eval(script)
})
afterEach(async () => { browser.dispatchEvent(new browser.Event('pagehide')); await browser.happyDOM.close(); vi.useRealTimers() })
const text = (id: string) => browser.document.getElementById(id)!.textContent

it('shows updates as plain text and clears view/aria/bitmap when a disconnect has no view', async () => {
  await vi.advanceTimersByTimeAsync(0)
  expect(text('status')).toBe('ライブ表示中')
  expect(text('glass-content')).toBe('<img src=x onerror=alert(1)>')
  expect(browser.document.querySelector('#glass-content img')).toBeNull()
  frame = { view: null, state: 'disconnected', updatedAt: now }
  await vi.advanceTimersByTimeAsync(500)
  expect(text('glass-content')).toBe('')
  expect(browser.document.getElementById('glass-content')!.hasAttribute('aria-label')).toBe(false)
  expect(browser.document.getElementById('small-content')!.hasAttribute('hidden')).toBe(true)
})

it('erases previous person data after 120 seconds even when the server stays offline', async () => {
  await vi.advanceTimersByTimeAsync(0)
  expect(text('glass-header')).toBe('架空の人物')
  offline = true
  await vi.advanceTimersByTimeAsync(119999)
  expect(text('glass-header')).toBe('架空の人物')
  await vi.advanceTimersByTimeAsync(1)
  expect(text('glass-content')).toBe('')
  expect(text('glass-header')).not.toContain('架空の人物')
  expect(browser.document.getElementById('glass-content')!.hasAttribute('aria-label')).toBe(false)
})

it('clears the prior display when there is no retained frame', async () => {
  await vi.advanceTimersByTimeAsync(0)
  frame = null
  await vi.advanceTimersByTimeAsync(500)
  expect(text('status')).toBe('グラスからの受信待ち')
  expect(text('glass-header')).not.toContain('架空の人物')
  expect(browser.document.getElementById('glass-content')!.hasAttribute('aria-label')).toBe(false)
})

it('distinguishes a connected phone still awaiting the first glasses display', async () => {
  await vi.advanceTimersByTimeAsync(0)
  frame = { view: null, state: 'connected', updatedAt: now }
  await vi.advanceTimersByTimeAsync(500)
  expect(text('status')).toBe('スマホ接続済み・画面待ち')
  expect(text('glass-content')).toBe('')
})
