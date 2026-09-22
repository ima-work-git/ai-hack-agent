import {
  AudioInputSource,
  CreateStartUpPageContainer,
  OsEventTypeList,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  RebuildPageContainer,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { renderGlassesBitmap } from './g2-bitmap'

export interface GlassesView {
  header: string
  content: string
  footer: string
}

export type G2Action = 'primary' | 'previous' | 'next' | 'exit'
export type G2State = 'idle' | 'connecting' | 'connected' | 'recording' | 'background'
  | 'disconnected' | 'unavailable' | 'error' | 'disposed'
export interface G2Status { state: G2State; reason?: string }

export interface G2Event {
  audioEvent?: { audioPcm: Uint8Array; source?: string }
  sysEvent?: { eventType?: number }
  textEvent?: { eventType?: number }
}

/** The SDK boundary is injectable; a bridge acknowledgement is not optical verification. */
export interface G2Bridge {
  createStartUpPageContainer(page: CreateStartUpPageContainer): Promise<number>
  textContainerUpgrade(text: TextContainerUpgrade): Promise<boolean>
  updateImageRawData?(image: ImageRawDataUpdate): Promise<ImageRawDataUpdateResult>
  rebuildPageContainer?(page: RebuildPageContainer): Promise<boolean>
  audioControl(open: boolean, source?: AudioInputSource): Promise<boolean>
  onEvenHubEvent(callback: (event: G2Event) => void): () => void
  onDeviceStatusChanged(callback: (status: { connectType: string }) => void): () => void
}

export interface G2RuntimeOptions {
  bridge?: G2Bridge
  getBridge?: () => Promise<G2Bridge>
  isHostAvailable?: () => boolean
  onStatus?: (status: G2Status) => void
  onAudio?: (chunk: Uint8Array) => void
  onAction?: (action: G2Action) => void
  timeoutMs?: number
  /** For ordinary capture: can shorten its window, never extend it beyond 30 seconds. */
  maxAudioMs?: number
  /** Test injection; production uses a local Canvas, never an external image API. */
  renderBitmap?: typeof renderGlassesBitmap
}

interface ViewJob {
  view: GlassesView
  token: string
  epoch: number
  sequence: number
  resolve: (displayAccepted: boolean) => void
}

const SAFE_VIEW: GlassesView = {
  header: '接続確認', content: 'スマホで操作を開始してください', footer: '音声取得は停止中',
}

class BridgeTimeout extends Error {}

function nativeHostAvailable(): boolean {
  if (typeof window === 'undefined') return false
  const host = (window as Window & {
    flutter_inappwebview?: { callHandler?: unknown }
  }).flutter_inappwebview
  return typeof host?.callHandler === 'function'
}

function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try { return Promise.resolve(operation()) } catch (error) { return Promise.reject(error) }
}

/** REQ-001/005/008: explicit capture, no retained subject view, bounded SDK calls. */
export class G2Runtime {
  private bridge: G2Bridge | null = null
  private connected = false
  private foreground = true
  private disposed = false
  private fatal = false
  private connectionVersion = 0
  private connecting: Promise<boolean> | null = null
  private unsubscribe: Array<() => void> = []
  private currentStatus: G2Status = { state: 'idle' }
  private readonly timeoutMs: number
  private readonly maxAudioMs: number
  private audioVersion = 0
  private audioStarting = false
  private audioStopping = 0
  private acceptingAudio = false
  private audioContinuous = false
  private audioBytes = 0
  private audioDeadline = 0
  private audioTimer: ReturnType<typeof setTimeout> | null = null
  private token = ''
  private viewEpoch = 0
  private viewSequence = 0
  private pending: ViewJob | null = null
  private flushing = false
  private imageMode = false
  private lastImageContent: string | null = null
  private lastText: Partial<GlassesView> = {}

  constructor(private readonly options: G2RuntimeOptions = {}) {
    this.timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(options.timeoutMs!, 10_000)) : 2_000
    this.maxAudioMs = Number.isFinite(options.maxAudioMs)
      ? Math.max(1, Math.min(options.maxAudioMs!, 30_000)) : 30_000
  }

  get status(): G2Status { return { ...this.currentStatus } }

  connect(initialView?: GlassesView, token = this.token): Promise<boolean> {
    if (this.disposed || this.fatal) return Promise.resolve(false)
    if (this.connecting) return this.connecting
    if (this.connected && this.foreground) {
      return initialView ? this.render(initialView, token) : Promise.resolve(true)
    }
    this.connecting = this.connectBridge(initialView, token).finally(() => { this.connecting = null })
    return this.connecting
  }

  /** Call on subject change/end BEFORE rendering with the new request token. */
  invalidateViews(nextToken: string): void {
    this.token = nextToken
    this.cancelViews()
  }

  render(view: GlassesView, token = this.token): Promise<boolean> {
    if (!this.usable() || token !== this.token) return Promise.resolve(false)
    if (![view.header, view.content, view.footer].every(text => typeof text === 'string' && text.length <= 2_000)) {
      this.notify('error', 'invalid_view')
      return Promise.resolve(false)
    }
    this.pending?.resolve(false)
    const result = new Promise<boolean>(resolve => {
      this.pending = { view: { ...view }, token, epoch: this.viewEpoch, sequence: ++this.viewSequence, resolve }
    })
    void this.flushViews()
    return result
  }

  /** Continuous capture is opt-in for the caller's explicit conversation start. */
  async startAudio(options: { continuous?: boolean } = {}): Promise<boolean> {
    if (!this.usable() || this.audioStarting || this.audioStopping > 0) return false
    if (this.acceptingAudio) return true
    const bridge = this.bridge!
    const version = ++this.audioVersion
    this.audioStarting = true
    this.audioContinuous = options.continuous === true
    this.audioBytes = 0
    this.audioDeadline = this.audioContinuous ? Infinity : Date.now() + this.maxAudioMs
    // The deadline starts at the request, not a possibly delayed acknowledgement.
    if (!this.audioContinuous) {
      this.audioTimer = setTimeout(() => { void this.stopAudio('duration_limit') }, this.maxAudioMs)
    }
    const opening = invoke(() => bridge.audioControl(true, AudioInputSource.Glasses))
    // A timed-out or cancelled open can complete later: issue another close then.
    void opening.then(opened => {
      if (opened && (version !== this.audioVersion || this.disposed || !this.foreground || !this.connected)) {
        void this.closeMicrophone(bridge).then(closed => {
          if (!closed) {
            this.fatal = true
            this.notify(this.disposed ? 'disposed' : 'error', 'audio_stop_failed')
          }
        })
      }
    }, () => {})
    try {
      const opened = await this.deadline(opening)
      if (version !== this.audioVersion || !this.usable()) return false
      if (Date.now() >= this.audioDeadline) {
        await this.stopAudio('duration_limit')
        return false
      }
      if (!opened) {
        await this.stopAudio('audio_start_failed')
        this.notify('error', 'audio_start_failed')
        return false
      }
      this.acceptingAudio = true
      this.notify('recording')
      return true
    } catch (error) {
      if (error instanceof BridgeTimeout) this.fatal = true
      await this.stopAudio('audio_start_failed')
      if (!this.disposed) this.notify('error', error instanceof BridgeTimeout ? 'audio_start_timeout' : 'audio_start_failed')
      return false
    } finally {
      this.audioStarting = false
    }
  }

  async stopAudio(reason = 'stopped'): Promise<boolean> {
    this.acceptingAudio = false
    this.audioVersion += 1
    if (this.audioTimer !== null) clearTimeout(this.audioTimer)
    this.audioTimer = null
    this.audioContinuous = false
    this.audioBytes = 0
    this.audioDeadline = 0
    const bridge = this.bridge
    if (!bridge) return true
    const closed = await this.closeMicrophone(bridge)
    if (!this.disposed) {
      if (!closed) {
        this.fatal = true
        this.notify('error', 'audio_stop_failed')
      } else if (this.connected && this.foreground && !this.fatal) this.notify('connected', reason)
    }
    return closed
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.connected = false
    this.clearDisplayCache()
    this.connectionVersion += 1
    this.cancelViews()
    this.removeSubscriptions()
    const closed = await this.stopAudio()
    this.bridge = null
    this.notify('disposed', closed ? undefined : 'audio_stop_failed')
  }

  private async connectBridge(initialView: GlassesView | undefined, token: string): Promise<boolean> {
    this.clearDisplayCache()
    const injected = Boolean(this.options.bridge || this.options.getBridge)
    if (!(this.options.isHostAvailable?.() ?? (injected || nativeHostAvailable()))) {
      this.notify('unavailable', 'no_native_host')
      return false
    }
    const version = ++this.connectionVersion
    this.cancelViews()
    const viewEpoch = this.viewEpoch
    this.removeSubscriptions()
    this.notify('connecting')
    try {
      const bridge = await this.deadline(this.options.bridge ? Promise.resolve(this.options.bridge)
        : invoke(this.options.getBridge ?? waitForEvenAppBridge))
      if (this.disposed || version !== this.connectionVersion) return false
      this.bridge = bridge
      this.imageMode = Boolean(bridge.updateImageRawData && bridge.rebuildPageContainer &&
        (this.options.renderBitmap ?? renderGlassesBitmap)(SAFE_VIEW.content))
      // Never put a person's details in an uncancellable startup operation.
      const result = await this.deadline(invoke(() => bridge.createStartUpPageContainer(this.startupPage())))
      if (this.disposed || version !== this.connectionVersion) return false
      if (result !== 0) {
        this.notify('error', 'startup_rejected')
        return false
      }
      this.connected = true
      this.foreground = true
      this.unsubscribe.push(bridge.onEvenHubEvent(event => {
        if (!this.disposed && version === this.connectionVersion) this.handleEvent(event)
      }))
      this.unsubscribe.push(bridge.onDeviceStatusChanged(status => {
        if (!this.disposed && version === this.connectionVersion
          && ['disconnected', 'connectionFailed'].includes(status.connectType)) {
          this.suspend('disconnected', 'device_disconnected')
        }
      }))
      this.notify('connected', 'bridge_acknowledged')
      // Invalidation while connect was waiting must not resurrect an old view.
      if (initialView && token === this.token && viewEpoch === this.viewEpoch) return this.render(initialView, token)
      if (this.imageMode) return this.render(SAFE_VIEW, this.token)
      return true
    } catch (error) {
      this.connected = false
      this.removeSubscriptions()
      if (error instanceof BridgeTimeout) this.fatal = true
      if (!this.disposed) this.notify('error', error instanceof BridgeTimeout ? 'connect_timeout' : 'connect_failed')
      return false
    }
  }

  private handleEvent(event: G2Event): void {
    const eventType = event.sysEvent?.eventType ?? event.textEvent?.eventType
    if (eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      this.suspend('background', 'background')
      return
    }
    if (eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      this.foreground = true
      if (this.connected && !this.fatal) this.notify('connected', 'resume_required')
      return
    }
    if ([OsEventTypeList.SYSTEM_EXIT_EVENT, OsEventTypeList.ABNORMAL_EXIT_EVENT, OsEventTypeList.DOUBLE_CLICK_EVENT]
      .includes(eventType as OsEventTypeList)) {
      this.suspend('disconnected', 'host_exit')
      this.action('exit')
      return
    }
    if (!this.usable()) return
    const audio = event.audioEvent
    if (audio && this.acceptingAudio && Date.now() >= this.audioDeadline) {
      void this.stopAudio('duration_limit')
      return
    }
    if (audio && this.acceptingAudio && audio.source === AudioInputSource.Glasses
      && audio.audioPcm instanceof Uint8Array && audio.audioPcm.length > 0 && audio.audioPcm.length % 2 === 0) {
      if (!this.audioContinuous) {
        this.audioBytes += audio.audioPcm.length
        if (this.audioBytes > Math.floor(this.maxAudioMs * 32)) {
          void this.stopAudio('audio_size_limit')
          return
        }
      }
      try { this.options.onAudio?.(audio.audioPcm.slice()) } catch { void this.stopAudio('audio_handler_failed') }
    }
    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) this.action('previous')
    else if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) this.action('next')
    else if (event.textEvent && (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined)) this.action('primary')
  }

  private suspend(state: 'background' | 'disconnected', reason: string): void {
    this.clearDisplayCache()
    if (state === 'background') this.foreground = false
    else this.connected = false
    this.cancelViews()
    this.notify(state, reason)
    void this.stopAudio(reason)
  }

  private async flushViews(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.pending && this.usable()) {
        const job = this.pending
        this.pending = null
        let success = true
        if (this.imageMode && this.current(job) && this.lastImageContent !== job.view.content) {
          try {
            // A partly written pair must never be mistaken for the previous complete pair.
            this.lastImageContent = null
            const images = (this.options.renderBitmap ?? renderGlassesBitmap)(job.view.content)
            let accepted = images !== null
            if (images) for (const [index, imageData] of images.entries()) {
              if (!this.currentImage(job)) { accepted = false; break }
              const result = await this.deadline(invoke(() => this.bridge!.updateImageRawData!(new ImageRawDataUpdate({
                containerID: index + 4, containerName: `small-text-${index}`, imageData,
              }))))
              if (!ImageRawDataUpdateResult.isSuccess(result)) { accepted = false; break }
            }
            if (accepted && this.currentImage(job)) this.lastImageContent = job.view.content
            else if (!accepted && this.currentImage(job)) await this.fallbackToText()
          } catch (error) {
            try {
              if (error instanceof BridgeTimeout || !this.currentImage(job)) throw error
              await this.fallbackToText()
            } catch {
              success = false; this.fatal = true; this.cancelViews(); void this.stopAudio()
              if (!this.disposed) this.notify('error', error instanceof BridgeTimeout ? 'display_timeout' : 'display_failed')
            }
          }
        }
        for (const [index, name] of (['header', 'content', 'footer'] as const).entries()) {
          if (!this.current(job)) { success = false; break }
          if (this.imageMode && name === 'content') continue
          if (this.lastText[name] === job.view[name]) continue
          try {
            delete this.lastText[name]
            const accepted = await this.deadline(invoke(() => this.bridge!.textContainerUpgrade(
              new TextContainerUpgrade({ containerID: index + 1, containerName: name, content: job.view[name] }),
            )))
            if (!accepted) throw new Error('display_rejected')
            if (this.current(job)) this.lastText[name] = job.view[name]
          } catch (error) {
            success = false
            // Native calls cannot be cancelled. Do not start another write after timeout.
            this.fatal = true
            this.cancelViews()
            void this.stopAudio()
            if (!this.disposed) this.notify('error', error instanceof BridgeTimeout ? 'display_timeout' : 'display_failed')
            break
          }
        }
        job.resolve(success && this.current(job))
      }
    } finally {
      this.flushing = false
    }
  }

  private current(job: ViewJob): boolean {
    return this.usable() && job.epoch === this.viewEpoch && job.token === this.token && job.sequence === this.viewSequence
  }

  private currentImage(job: ViewJob): boolean {
    // New speech status must not starve an in-flight pair of unchanged topic images.
    return this.usable() && job.epoch === this.viewEpoch && job.token === this.token &&
      (job.sequence === this.viewSequence || this.pending?.view.content === job.view.content)
  }

  private usable(): boolean { return this.connected && this.foreground && !this.disposed && !this.fatal && this.bridge !== null }

  private cancelViews(): void {
    this.viewEpoch += 1
    this.pending?.resolve(false)
    this.pending = null
  }

  private async closeMicrophone(bridge: G2Bridge): Promise<boolean> {
    this.audioStopping += 1
    try { return await this.deadline(invoke(() => bridge.audioControl(false))) === true }
    catch { return false }
    finally { this.audioStopping -= 1 }
  }

  private deadline<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeTimeout()), this.timeoutMs)
      operation.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
  }

  private removeSubscriptions(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      try { unsubscribe() } catch { /* Cleanup must still stop the microphone. */ }
    }
  }

  private notify(state: G2State, reason?: string): void {
    this.currentStatus = reason ? { state, reason } : { state }
    try { this.options.onStatus?.({ ...this.currentStatus }) } catch { /* A UI callback cannot block cleanup. */ }
  }

  private action(action: G2Action): void {
    try { this.options.onAction?.(action) } catch { /* No data or callback exception is logged. */ }
  }

  private async fallbackToText(): Promise<void> {
    this.clearDisplayCache()
    this.imageMode = false
    const page = this.startupPage()
    const accepted = await this.deadline(invoke(() => this.bridge!.rebuildPageContainer!(new RebuildPageContainer({
      containerTotalNum: page.containerTotalNum, textObject: page.textObject,
    }))))
    if (!accepted) throw new Error('text_fallback_failed')
  }

  private clearDisplayCache(): void { this.lastImageContent = null; this.lastText = {} }

  private startupPage(): CreateStartUpPageContainer {
    const geometry = [{ y: 0, height: 48 }, { y: 52, height: 184 }, { y: 240, height: 48 }]
    const names = ['header', 'content', 'footer'] as const
    const textObject = names.map((name, index) => new TextContainerProperty({
      xPosition: 0, yPosition: geometry[index]!.y, width: 576, height: geometry[index]!.height,
      borderWidth: index === 2 ? 0 : 1, borderColor: 5, borderRadius: 4, paddingLength: 6,
      containerID: index + 1, containerName: name, content: this.imageMode && name === 'content' ? ' ' : SAFE_VIEW[name], isEventCapture: index === 1 ? 1 : 0,
      ...(this.imageMode ? { zOrderIndex: index + 1 } : {}),
    }))
    const imageObject = this.imageMode ? [0, 1].map(index => new ImageContainerProperty({
      xPosition: index * 288, yPosition: 66, width: 288, height: 144,
      containerID: index + 4, containerName: `small-text-${index}`, zOrderIndex: index + 4,
    })) : undefined
    return new CreateStartUpPageContainer({ containerTotalNum: textObject.length + (imageObject?.length ?? 0), textObject, ...(imageObject ? { imageObject } : {}) })
  }
}
