import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioInputSource, ImageRawDataUpdateResult, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { G2Runtime, type G2Bridge, type G2Event, type GlassesView } from '../src/integrations/g2-runtime'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fakeBridge() {
  let eventHandler: (event: G2Event) => void = () => {}
  let statusHandler: (status: { connectType: string }) => void = () => {}
  const unsubscribeEvent = vi.fn()
  const unsubscribeStatus = vi.fn()
  const bridge: G2Bridge = {
    createStartUpPageContainer: vi.fn(async () => 0),
    textContainerUpgrade: vi.fn(async () => true),
    audioControl: vi.fn(async () => true),
    onEvenHubEvent: vi.fn(callback => { eventHandler = callback; return unsubscribeEvent }),
    onDeviceStatusChanged: vi.fn(callback => { statusHandler = callback; return unsubscribeStatus }),
  }
  return { bridge, event: (value: G2Event) => eventHandler(value), device: (connectType: string) => statusHandler({ connectType }), unsubscribeEvent, unsubscribeStatus }
}

const view = (name: string): GlassesView => ({ header: `${name}-header`, content: `${name}-content`, footer: `${name}-footer` })
const pcm = (source = 'glasses') => ({ audioEvent: { audioPcm: new Uint8Array([1, 2, 3, 4]), source } })

describe('G2Runtime — REQ-001/005/008, T-01/02/06/10 (injected bridge, not hardware)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does not call the bridge in an ordinary browser or start recording during connection', async () => {
    const getBridge = vi.fn()
    const unavailable = new G2Runtime({ getBridge, isHostAvailable: () => false })
    expect(await unavailable.connect()).toBe(false)
    expect(getBridge).not.toHaveBeenCalled()
    expect(unavailable.status.state).toBe('unavailable')
    const { bridge } = fakeBridge()
    const runtime = new G2Runtime({ bridge })
    expect(await runtime.connect()).toBe(true)
    expect(bridge.audioControl).not.toHaveBeenCalled()
    expect(bridge.createStartUpPageContainer).toHaveBeenCalledOnce()
    await runtime.dispose()
  })

  it('keeps the four-row board in one bounded display container without paging', async () => {
    const { bridge } = fakeBridge()
    const runtime = new G2Runtime({ bridge })
    await runtime.connect()
    const page = vi.mocked(bridge.createStartUpPageContainer).mock.calls[0]![0]
    const containers = page.textObject!
    for (const container of containers) {
      expect(container.xPosition! + container.width!).toBeLessThanOrEqual(576)
      expect(container.yPosition! + container.height!).toBeLessThanOrEqual(288)
    }
    const content = containers.find(container => container.containerName === 'content')!
    expect(content.height! - 2 * content.paddingLength!).toBeGreaterThanOrEqual(160)
    const rows = ['1 事:公開事実 問:質問例？', '2 事:公開事実 問:質問例？', '3 事:未確認 問:—', '4 事:未確認 問:—'].join('\n')
    expect(await runtime.render({ header: '調査結果 2/4件', content: rows, footer: '事=事実 問=質問 / 原文はスマホ' })).toBe(true)
    const update = vi.mocked(bridge.textContainerUpgrade).mock.calls.find(([value]) => value.containerName === 'content')![0]
    expect(update.content).toBe(rows)
    expect(update.content!.split('\n')).toHaveLength(4)
    await runtime.dispose()
  })

  it('serializes two small-text image tiles and rebuilds ordinary text if images are rejected', async () => {
    const { bridge } = fakeBridge()
    bridge.updateImageRawData = vi.fn(async () => ImageRawDataUpdateResult.success)
    bridge.rebuildPageContainer = vi.fn(async () => true)
    const runtime = new G2Runtime({ bridge, enableImageText: true, renderBitmap: () => [new Uint8Array([1]), new Uint8Array([2])] })
    expect(await runtime.connect()).toBe(true)
    const page = vi.mocked(bridge.createStartUpPageContainer).mock.calls[0]![0]
    expect(page.containerTotalNum).toBe(5)
    expect(page.imageObject).toHaveLength(2)
    expect(page.textObject!.filter(container => container.isEventCapture === 1)).toHaveLength(1)
    expect([...page.textObject!, ...page.imageObject!].map(container => container.zOrderIndex)).toEqual([1, 2, 3, 4, 5])
    for (const image of page.imageObject!) {
      expect(image.width).toBe(288); expect(image.height).toBe(144)
      expect(image.xPosition! + image.width!).toBeLessThanOrEqual(576)
      expect(image.yPosition! + image.height!).toBeLessThanOrEqual(288)
    }
    vi.mocked(bridge.updateImageRawData).mockClear()
    const first = deferred<ImageRawDataUpdateResult>()
    vi.mocked(bridge.updateImageRawData).mockImplementationOnce(() => first.promise)
    const rendered = runtime.render(view('small'))
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(1)
    const newerFooter = runtime.render({ ...view('small'), footer: '音声認識中' })
    first.resolve(ImageRawDataUpdateResult.success)
    expect(await rendered).toBe(false)
    expect(await newerFooter).toBe(true)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(2)
    vi.mocked(bridge.textContainerUpgrade).mockClear()
    expect(await runtime.render({ ...view('small'), footer: '音声認識中：最新の言葉' })).toBe(true)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(2)
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bridge.textContainerUpgrade).mock.calls[0]![0].containerName).toBe('footer')
    vi.mocked(bridge.updateImageRawData).mockResolvedValue(ImageRawDataUpdateResult.imageSizeInvalid)
    expect(await runtime.render(view('fallback'))).toBe(true)
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce()
    expect(vi.mocked(bridge.rebuildPageContainer).mock.calls[0]![0].containerTotalNum).toBe(3)
    expect(vi.mocked(bridge.textContainerUpgrade).mock.calls.some(([update]) => update.content === 'fallback-content')).toBe(true)
    await runtime.dispose()
  })

  it('does not reuse a bitmap cache after an interrupted pair or a background transition', async () => {
    const f = fakeBridge()
    f.bridge.updateImageRawData = vi.fn(async () => ImageRawDataUpdateResult.success)
    f.bridge.rebuildPageContainer = vi.fn(async () => true)
    const runtime = new G2Runtime({ bridge: f.bridge, enableImageText: true, renderBitmap: () => [new Uint8Array([1]), new Uint8Array([2])] })
    await runtime.connect(); await runtime.render(view('original'))
    vi.mocked(f.bridge.updateImageRawData).mockClear()
    const first = deferred<ImageRawDataUpdateResult>()
    vi.mocked(f.bridge.updateImageRawData).mockImplementationOnce(() => first.promise)
    const interrupted = runtime.render(view('changed'))
    const restored = runtime.render(view('original'))
    first.resolve(ImageRawDataUpdateResult.success)
    expect(await interrupted).toBe(false); expect(await restored).toBe(true)
    expect(f.bridge.updateImageRawData).toHaveBeenCalledTimes(3)
    f.event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } })
    f.event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } })
    expect(await runtime.render(view('original'))).toBe(true)
    expect(f.bridge.updateImageRawData).toHaveBeenCalledTimes(5)
    await runtime.dispose()
  })

  it.each([1, 2, 3])('rejects startup return code %s', async code => {
    const { bridge } = fakeBridge()
    vi.mocked(bridge.createStartUpPageContainer).mockResolvedValue(code)
    const runtime = new G2Runtime({ bridge })
    expect(await runtime.connect()).toBe(false)
    expect(await runtime.startAudio()).toBe(false)
    expect(runtime.status).toEqual({ state: 'error', reason: 'startup_rejected' })
  })

  it('times out a hanging bridge and never reports connection success', async () => {
    const runtime = new G2Runtime({ getBridge: () => new Promise(() => {}), timeoutMs: 100 })
    const result = runtime.connect()
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toBe(false)
    expect(runtime.status).toEqual({ state: 'error', reason: 'connect_timeout' })
  })

  it('only forwards glasses PCM after an acknowledged explicit start and stops at 30 seconds', async () => {
    const f = fakeBridge()
    const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAudio, maxAudioMs: 60_000 })
    await runtime.connect()
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    expect(await runtime.startAudio()).toBe(true)
    expect(f.bridge.audioControl).toHaveBeenCalledWith(true, AudioInputSource.Glasses)
    f.event(pcm('phone'))
    f.event({ audioEvent: { audioPcm: new Uint8Array([1, 2]) } })
    expect(onAudio).not.toHaveBeenCalled()
    f.event(pcm())
    expect(onAudio).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    f.event(pcm())
    expect(onAudio).toHaveBeenCalledOnce()
    expect(f.bridge.audioControl).toHaveBeenLastCalledWith(false)
    expect(runtime.status).toEqual({ state: 'connected', reason: 'duration_limit' })
    await runtime.dispose()
  })

  it('accepts more than one minute of continuous PCM until explicit stop closes the microphone', async () => {
    const f = fakeBridge()
    const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAudio })
    await runtime.connect()
    expect(await runtime.startAudio({ continuous: true })).toBe(true)
    const frame = { audioEvent: { audioPcm: new Uint8Array(32_000), source: AudioInputSource.Glasses } }
    for (let second = 0; second < 61; second++) {
      await vi.advanceTimersByTimeAsync(1_000)
      f.event(frame)
    }
    expect(runtime.status.state).toBe('recording')
    expect(onAudio).toHaveBeenCalledTimes(61)
    expect(f.bridge.audioControl).toHaveBeenCalledExactlyOnceWith(true, AudioInputSource.Glasses)
    expect(await runtime.stopAudio()).toBe(true)
    expect(f.bridge.audioControl).toHaveBeenLastCalledWith(false)
    f.event(frame)
    expect(onAudio).toHaveBeenCalledTimes(61)
    // A subsequent ordinary start still has the original 30-second protection.
    expect(await runtime.startAudio()).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(runtime.status).toEqual({ state: 'connected', reason: 'duration_limit' })
    f.event(frame)
    expect(onAudio).toHaveBeenCalledTimes(61)
    await runtime.dispose()
  })

  it('rejects audio start failure and immediately ignores frames after manual stop', async () => {
    const f = fakeBridge()
    const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAudio })
    await runtime.connect()
    vi.mocked(f.bridge.audioControl).mockResolvedValueOnce(false)
    expect(await runtime.startAudio()).toBe(false)
    expect(runtime.status.reason).toBe('audio_start_failed')
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    expect(await runtime.startAudio()).toBe(true)
    const closing = deferred<boolean>()
    vi.mocked(f.bridge.audioControl).mockReturnValueOnce(closing.promise)
    const stopped = runtime.stopAudio()
    expect(await runtime.startAudio()).toBe(false)
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    closing.resolve(true)
    expect(await stopped).toBe(true)
    await runtime.dispose()
  })

  it('rejects frames beyond the wall-clock deadline even when the timeout callback has not run', async () => {
    const f = fakeBridge()
    const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAudio })
    await runtime.connect()
    await runtime.startAudio()
    vi.setSystemTime(Date.now() + 30_001)
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    expect(f.bridge.audioControl).toHaveBeenLastCalledWith(false)
    await runtime.dispose()
  })

  it('does not send an initial subject view invalidated while startup is pending', async () => {
    const f = fakeBridge()
    const startup = deferred<number>()
    vi.mocked(f.bridge.createStartUpPageContainer).mockReturnValueOnce(startup.promise)
    const runtime = new G2Runtime({ bridge: f.bridge })
    const connected = runtime.connect(view('obsolete'))
    await Promise.resolve()
    await Promise.resolve()
    runtime.invalidateViews('')
    startup.resolve(0)
    expect(await connected).toBe(true)
    expect(f.bridge.textContainerUpgrade).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('closes a delayed microphone open again after stop, without accepting its audio', async () => {
    const f = fakeBridge()
    const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAudio })
    await runtime.connect()
    const opening = deferred<boolean>()
    vi.mocked(f.bridge.audioControl).mockReturnValueOnce(opening.promise)
    const started = runtime.startAudio()
    await runtime.stopAudio()
    opening.resolve(true)
    expect(await started).toBe(false)
    await Promise.resolve()
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    expect(vi.mocked(f.bridge.audioControl).mock.calls.filter(([open]) => !open)).toHaveLength(2)
    await runtime.dispose()
  })

  it('surfaces a failed stop and rejects further capture instead of claiming the microphone stopped', async () => {
    const f = fakeBridge()
    const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAudio })
    await runtime.connect()
    await runtime.startAudio()
    vi.mocked(f.bridge.audioControl).mockResolvedValueOnce(false)
    expect(await runtime.stopAudio()).toBe(false)
    expect(runtime.status).toEqual({ state: 'error', reason: 'audio_stop_failed' })
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    expect(await runtime.startAudio()).toBe(false)
    await runtime.dispose()
  })

  it('does not finish a card or reopen capture after disposal', async () => {
    const f = fakeBridge()
    const firstWrite = deferred<boolean>()
    vi.mocked(f.bridge.textContainerUpgrade).mockReturnValueOnce(firstWrite.promise)
    const runtime = new G2Runtime({ bridge: f.bridge })
    await runtime.connect()
    const rendered = runtime.render(view('cancelled'))
    await runtime.dispose()
    firstWrite.resolve(true)
    expect(await rendered).toBe(false)
    expect(f.bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
    expect(await runtime.startAudio()).toBe(false)
  })

  it('closes a timed-out open and prevents a late acknowledgement from restarting capture', async () => {
    const f = fakeBridge()
    const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAudio, timeoutMs: 100 })
    await runtime.connect()
    const opening = deferred<boolean>()
    vi.mocked(f.bridge.audioControl).mockReturnValueOnce(opening.promise)
    const started = runtime.startAudio()
    await vi.advanceTimersByTimeAsync(100)
    expect(await started).toBe(false)
    expect(runtime.status.reason).toBe('audio_start_timeout')
    opening.resolve(true)
    await Promise.resolve()
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    expect(await runtime.startAudio()).toBe(false)
    await runtime.dispose()
  })

  it('serializes updates, skips obsolete queued views, and finishes with only the newest view', async () => {
    const f = fakeBridge()
    const firstWrite = deferred<boolean>()
    vi.mocked(f.bridge.textContainerUpgrade).mockReturnValueOnce(firstWrite.promise)
    const runtime = new G2Runtime({ bridge: f.bridge })
    await runtime.connect()
    const first = runtime.render(view('first'))
    const skipped = runtime.render(view('skipped'))
    const newest = runtime.render(view('newest'))
    expect(f.bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
    expect(await skipped).toBe(false)
    firstWrite.resolve(true)
    expect(await first).toBe(false)
    expect(await newest).toBe(true)
    const written = vi.mocked(f.bridge.textContainerUpgrade).mock.calls.map(([value]) => value.content)
    expect(written).toEqual(['first-header', 'newest-header', 'newest-content', 'newest-footer'])
    await runtime.dispose()
  })

  it('invalidates an in-flight subject and rejects delayed renders carrying the old token', async () => {
    const f = fakeBridge()
    const firstWrite = deferred<boolean>()
    vi.mocked(f.bridge.textContainerUpgrade).mockReturnValueOnce(firstWrite.promise)
    const runtime = new G2Runtime({ bridge: f.bridge })
    await runtime.connect()
    runtime.invalidateViews('old')
    const oldResult = runtime.render(view('old'), 'old')
    runtime.invalidateViews('new')
    expect(await runtime.render(view('late-old'), 'old')).toBe(false)
    const newResult = runtime.render(view('new'), 'new')
    firstWrite.resolve(true)
    expect(await oldResult).toBe(false)
    expect(await newResult).toBe(true)
    const written = vi.mocked(f.bridge.textContainerUpgrade).mock.calls.map(([value]) => value.content)
    expect(written).not.toContain('old-content')
    expect(written).not.toContain('late-old-header')
    await runtime.dispose()
  })

  it.each(['false', 'timeout'] as const)('does not report failed display %s as success or continue writing', async failure => {
    const f = fakeBridge()
    vi.mocked(f.bridge.textContainerUpgrade).mockImplementationOnce(() => failure === 'false'
      ? Promise.resolve(false) : new Promise(() => {}))
    const runtime = new G2Runtime({ bridge: f.bridge, timeoutMs: 100 })
    await runtime.connect()
    const result = runtime.render(view('one'))
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(100)
    expect(await result).toBe(false)
    expect(await runtime.render(view('two'))).toBe(false)
    expect(f.bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
    expect(runtime.status.state).toBe('error')
    await runtime.dispose()
  })

  it.each([false, true])('stops in the background without automatic replay or recording (continuous=%s)', async continuous => {
    const f = fakeBridge()
    const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAudio })
    await runtime.connect()
    await runtime.startAudio({ continuous })
    f.event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } })
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    expect(await runtime.render(view('hidden'))).toBe(false)
    f.event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } })
    expect(f.bridge.textContainerUpgrade).not.toHaveBeenCalled()
    expect(vi.mocked(f.bridge.audioControl).mock.calls.filter(([open]) => open)).toHaveLength(1)
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it.each([false, true])('stops on disconnect and requires explicit reconnect (continuous=%s)', async continuous => {
    const f = fakeBridge()
    const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAudio })
    await runtime.connect()
    await runtime.startAudio({ continuous })
    f.device('disconnected')
    expect(await runtime.startAudio()).toBe(false)
    f.device('connected')
    expect(await runtime.render(view('not-reconnected'))).toBe(false)
    f.event(pcm())
    expect(onAudio).not.toHaveBeenCalled()
    await runtime.dispose()
    expect(f.unsubscribeEvent).toHaveBeenCalledOnce()
    expect(f.unsubscribeStatus).toHaveBeenCalledOnce()
    expect(runtime.status.state).toBe('disposed')
    expect(await runtime.connect()).toBe(false)
    expect(await runtime.render(view('disposed'))).toBe(false)
  })

  it('maps navigation and the protobuf zero click without logging content', async () => {
    const f = fakeBridge()
    const onAction = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAction })
    await runtime.connect()
    f.event({ textEvent: {} })
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)
    f.event({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } })
    await vi.advanceTimersByTimeAsync(500)
    f.event({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } })
    f.event({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    await vi.advanceTimersByTimeAsync(500)
    f.event({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    expect(onAction.mock.calls.flat()).toEqual(['primary', 'primary', 'previous', 'next', 'secondary'])
    await runtime.dispose()
  })

  it.each([
    { sysEvent: {} }, { textEvent: {} },
    { sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } },
    { textEvent: { eventType: OsEventTypeList.CLICK_EVENT } },
  ])('defers a single tap for double-tap disambiguation, including omitted protobuf zero: %j', async event => {
    const f = fakeBridge(); const onAction = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAction })
    await runtime.connect()
    f.event(event)
    await vi.advanceTimersByTimeAsync(499)
    expect(onAction).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onAction).toHaveBeenCalledExactlyOnceWith('primary')
    await runtime.dispose()
  })

  it('cancels a pending primary on double-tap, suppresses duplicate/trailing tap events, and keeps audio running', async () => {
    const f = fakeBridge(); const onAction = vi.fn(); const onAudio = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAction, onAudio })
    await runtime.connect(); await runtime.startAudio({ continuous: true })
    f.event({ sysEvent: {} })
    await vi.advanceTimersByTimeAsync(250)
    f.event({ sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } })
    await vi.advanceTimersByTimeAsync(150)
    f.event({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    f.event({ textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    f.event({ sysEvent: {} })
    f.event(pcm())
    await vi.advanceTimersByTimeAsync(500)
    expect(onAction).toHaveBeenCalledExactlyOnceWith('secondary')
    expect(runtime.status.state).toBe('recording')
    expect(onAudio).toHaveBeenCalledOnce()
    expect(vi.mocked(f.bridge.audioControl).mock.calls.filter(([open]) => !open)).toHaveLength(0)
    // A later deliberate single tap remains usable after the suppression window.
    f.event({ sysEvent: {} })
    await vi.advanceTimersByTimeAsync(500)
    expect(onAction.mock.calls.flat()).toEqual(['secondary', 'primary'])
    await runtime.dispose()
  })

  it.each(['sys-first', 'text-first'] as const)('suppresses a trailing sibling click and late double after an accepted primary (%s)', async order => {
    const f = fakeBridge(); const onAction = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAction })
    await runtime.connect(); await runtime.startAudio({ continuous: true })
    const first = order === 'sys-first' ? { sysEvent: {} } : { textEvent: {} }
    const sibling = order === 'sys-first' ? { textEvent: { eventType: OsEventTypeList.CLICK_EVENT } } : { sysEvent: { eventType: OsEventTypeList.CLICK_EVENT } }
    f.event(first); await vi.advanceTimersByTimeAsync(500)
    expect(onAction).toHaveBeenCalledExactlyOnceWith('primary')
    // The UI may already have accepted a navigation confirmation. The same
    // physical tap arriving through another envelope must not act on that page.
    f.event(sibling); await vi.advanceTimersByTimeAsync(200)
    f.event({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    await vi.advanceTimersByTimeAsync(299)
    expect(onAction).toHaveBeenCalledExactlyOnceWith('primary')
    expect(runtime.status.state).toBe('recording')
    expect(vi.mocked(f.bridge.audioControl).mock.calls.filter(([open]) => !open)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    f.event(first); await vi.advanceTimersByTimeAsync(500)
    expect(onAction.mock.calls.flat()).toEqual(['primary', 'primary'])
    await runtime.dispose()
  })

  it('keeps accepted-tap suppression across a synchronous subject/view invalidation', async () => {
    const f = fakeBridge(); const onAction = vi.fn(() => runtime.invalidateViews('changed'))
    const runtime = new G2Runtime({ bridge: f.bridge, onAction })
    await runtime.connect(); f.event({ sysEvent: {} })
    await vi.advanceTimersByTimeAsync(500)
    f.event({ textEvent: {} })
    f.event({ textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    await vi.advanceTimersByTimeAsync(500)
    expect(onAction).toHaveBeenCalledExactlyOnceWith('primary')
    await runtime.dispose()
  })

  it.each([
    { sysEvent: {}, textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } },
    { sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }, textEvent: {} },
    { sysEvent: { eventType: OsEventTypeList.CLICK_EVENT }, textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } },
  ])('prioritizes explicit double-tap over an empty or zero-valued sibling envelope: %j', async event => {
    const f = fakeBridge(); const onAction = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAction })
    await runtime.connect(); f.event(event)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onAction).toHaveBeenCalledExactlyOnceWith('secondary')
    expect(runtime.status.state).toBe('connected')
    await runtime.dispose()
  })

  it.each(['background', 'foreground', 'system-exit', 'abnormal-exit', 'disconnected', 'connectionFailed', 'dispose', 'stop-audio', 'new-subject', 'scroll'] as const)
    ('discards a pending single tap during %s rather than applying it to a later state', async transition => {
      const f = fakeBridge(); const onAction = vi.fn()
      const runtime = new G2Runtime({ bridge: f.bridge, onAction })
      await runtime.connect(); await runtime.startAudio({ continuous: true })
      f.event({ sysEvent: {} })
      await vi.advanceTimersByTimeAsync(100)
      if (transition === 'background') f.event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } })
      else if (transition === 'foreground') f.event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } })
      else if (transition === 'system-exit') f.event({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } })
      else if (transition === 'abnormal-exit') f.event({ sysEvent: { eventType: OsEventTypeList.ABNORMAL_EXIT_EVENT } })
      else if (transition === 'disconnected' || transition === 'connectionFailed') f.device(transition)
      else if (transition === 'dispose') await runtime.dispose()
      else if (transition === 'stop-audio') await runtime.stopAudio()
      else if (transition === 'new-subject') runtime.invalidateViews('new-person')
      else if (transition === 'scroll') f.event({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
      await vi.advanceTimersByTimeAsync(1000)
      expect(onAction.mock.calls.flat()).not.toContain('primary')
      if (transition === 'system-exit' || transition === 'abnormal-exit') {
        expect(onAction).toHaveBeenCalledExactlyOnceWith('exit')
        expect(runtime.status.state).toBe('disconnected')
        expect(f.bridge.audioControl).toHaveBeenLastCalledWith(false)
      }
      await runtime.dispose()
    })

  it('does not reapply an old pending tap or old event subscription after reconnecting', async () => {
    const f = fakeBridge(); const onAction = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAction })
    await runtime.connect()
    const oldEvent = vi.mocked(f.bridge.onEvenHubEvent).mock.calls[0]![0]
    f.event({ sysEvent: {} }); f.device('disconnected')
    expect(await runtime.connect()).toBe(true)
    oldEvent({ sysEvent: {} })
    await vi.advanceTimersByTimeAsync(1000)
    expect(onAction).not.toHaveBeenCalled()
    f.event({ sysEvent: {} })
    await vi.advanceTimersByTimeAsync(500)
    expect(onAction).toHaveBeenCalledExactlyOnceWith('primary')
    await runtime.dispose()
  })

  it('does not interpret audio or unknown system events as taps, and preserves a real system exit over a double-tap', async () => {
    const f = fakeBridge(); const onAction = vi.fn()
    const runtime = new G2Runtime({ bridge: f.bridge, onAction })
    await runtime.connect(); await runtime.startAudio({ continuous: true })
    f.event(pcm()); f.event({}); f.event({ sysEvent: { eventType: OsEventTypeList.IMU_DATA_REPORT }, textEvent: {} })
    await vi.advanceTimersByTimeAsync(1000)
    expect(onAction).not.toHaveBeenCalled()
    f.event({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT }, textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    expect(onAction).toHaveBeenCalledExactlyOnceWith('exit')
    expect(runtime.status.state).toBe('disconnected')
    await runtime.dispose()
  })
})
