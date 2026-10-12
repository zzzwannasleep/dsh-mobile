import { createElement, useEffect, useState } from 'react'
import {
  DIAGNOSTIC_REASON_MESSAGES,
  LOCALIZED_DIAGNOSTIC_COPY,
  MOBILE_CONTROL_MESSAGES,
  type MobileControlLocale,
} from './client-messages.js'
import { installNativeMobileSurface, NATIVE_MOBILE_STYLES, resolveNativeMobileLanguage } from './native-mobile.js'
import { installVoiceSession } from './voice-session.js'
import { installMobileFontPreference, MobileFontSizeRow } from './mobile-font.js'
import { MobileDisplayScaleRow } from './mobile-display-scale.js'
import { CLIENT_MODULE_STYLES, ClientModuleSettingsRow, closeClientModuleDialog, disposeClientModuleDialogs } from './client-module-ui.js'
import { isDesktopAdminSurface, localAdminRequestHeaders } from './local-admin-host.js'
import { fireDeviceRevoked, fireTaskNotifyEvent, isDeviceRevokedPayload, parseTaskNotifyPayload, taskCompletionTag } from './task-notify.js'
import { EXTENSION_RECOVERY_STYLES, installExtensionRecoveryControl } from './extension-recovery-ui.js'
import { invokeBoundNativeCapability } from './native-capability.js'

export { DIAGNOSTIC_REASON_MESSAGES, LOCALIZED_DIAGNOSTIC_COPY, MOBILE_CONTROL_MESSAGES } from './client-messages.js'
export type { MobileControlLocale } from './client-messages.js'

/**
 * Remote provider names the control UI knows about.
 *
 * This mirrors the server-side union in `src/remote.ts`, which cannot be imported
 * here because it pulls in Node-only modules. An unrecognized value from the
 * host falls back to the primary channel (sakurafrp), so a missing name would
 * silently render another provider's wording instead of failing loudly.
 */
export type MobileRemoteProvider = 'cloudflared' | 'sakurafrp'

/** Map a host-reported provider onto the UI union, defaulting to the primary channel. */
export function parseMobileRemoteProvider(value: unknown): MobileRemoteProvider {
  return value === 'cloudflared' || value === 'sakurafrp'
    ? value
    : 'sakurafrp'
}

interface ClientContext {
  effect(effect: () => void | (() => void), label?: string): void
  get(name: 'connection'): MobileConnectionHandle
  get(name: string): unknown
  slots: {
    inject(key: string, callback: () => (() => void)): () => void
    register<Props>(options: { name: string; id: string; order?: number; priority?: number; label?: string }, component: (props: Props) => unknown): () => void
  }
}

interface MobileConnectionHandle {
  isLoopback: boolean
}

interface MobileExtensionContext {
  readonly document: Document
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly root: HTMLElement
  readonly window: Window
}

type MobileExtensionMount = (context: MobileExtensionContext) => void | (() => void)
type MobileSurfacePlacement = 'page' | 'sidebar-action' | 'header-action' | 'composer-dock' | 'settings-section' | 'overlay'

/**
 * Set a surface's visibility; opening a page or overlay brings it to the front.
 * @param container - the registered surface element.
 * @param open - whether to show it.
 */
export function setMobileSurfaceOpen(container: HTMLElement, open: boolean): void {
  container.hidden = !open
  if (open && container.isConnected
    && (container.dataset.dshMobileSurfacePlacement === 'page' || container.dataset.dshMobileSurfacePlacement === 'overlay')) {
    container.parentElement?.append(container)
  }
}

function visibleBackLayer(view: Window, element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.closest('[hidden],[inert],[aria-hidden="true"]') !== null) return false
  const style = view.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
}

/**
 * Consume page-level surfaces and dismissible DSH overlays before layout navigation.
 * Composer model popups use DSH's Escape handling to return from a pane before closing.
 * @param view - the page window receiving the native Back request.
 * @param page - the current DSH document.
 * @param blocked - feedback for a foreground layer without a safe close action.
 * @returns a disposer for the capture listener.
 */
export function installMobileNativeBack(view: Window, page: Document, blocked: () => void): () => void {
  const onBack = (event: Event): void => {
    if (!event.cancelable || event.defaultPrevented) return
    const claim = (): void => { event.preventDefault(); event.stopImmediatePropagation() }
    if (closeClientModuleDialog()) { claim(); return }
    const surfaces = [...page.querySelectorAll<HTMLElement>('[data-dsh-mobile-surface-placement="page"], [data-dsh-mobile-surface-placement="overlay"]')]
    const surface = surfaces.filter(element => visibleBackLayer(view, element)).at(-1)
    if (surface !== undefined) {
      setMobileSurfaceOpen(surface, false)
      claim()
      return
    }

    const modelPopups = new Map<HTMLElement, HTMLElement>()
    for (const trigger of page.querySelectorAll<HTMLElement>('[data-dsh-mobile-composer-model-trigger][aria-expanded="true"]')) {
      const popupId = trigger.getAttribute('aria-controls')
      const popup = popupId === null ? null : page.getElementById(popupId)
      if (popup !== null && visibleBackLayer(view, trigger) && visibleBackLayer(view, popup)
        && (popup.getAttribute('role') === 'menu' || popup.getAttribute('role') === 'group')) {
        modelPopups.set(popup, trigger)
      }
    }
    const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"], [role="group"][id]'
    const layers = [...page.querySelectorAll<HTMLElement>(modalSelector)].filter(element => visibleBackLayer(view, element)
      && (element.getAttribute('role') !== 'group' || modelPopups.has(element)))
    const top = layers.at(-1)
    if (top === undefined) return
    claim()
    const modelEntry = [...modelPopups].find(([popup]) => popup.contains(top))
    if (modelEntry !== undefined) {
      const [modelPopup, trigger] = modelEntry
      // Overlapping foreign layers do not establish that the model popup is foreground.
      if (layers.some(layer => !modelPopup.contains(layer))) { blocked(); return }
      const focused = page.activeElement
      const target = focused !== null && modelPopup.contains(focused) ? focused : trigger
      const escape = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
      target.dispatchEvent(escape)
      if (!escape.defaultPrevented) blocked()
      return
    }
    if (top.getAttribute('role') === 'dialog') {
      const wrapper = top.parentElement
      const mask = wrapper?.firstElementChild as HTMLElement | null | undefined
      const maskStyle = mask === undefined || mask === null ? undefined : view.getComputedStyle(mask)
      if (wrapper?.getAttribute('role') === 'presentation' && wrapper.children.length === 2
        && wrapper.lastElementChild === top && mask?.tagName === 'DIV'
        && mask.getAttribute('aria-hidden') === 'true' && mask.isConnected && !mask.hidden
        && maskStyle?.display !== 'none' && maskStyle?.visibility !== 'hidden' && mask.getClientRects().length > 0) {
        mask.click()
        return
      }
    } else if (top.getAttribute('data-menu-material') === 'translucent'
      && layers.filter(layer => layer.getAttribute('role') === 'menu').length === 1) {
      // DSH Menu closes on an outside pointerdown. Dispatch on the document,
      // never on an arbitrary menu item or third-party action.
      page.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      return
    }
    blocked()
  }
  const capture = { capture: true }
  view.addEventListener('dsh-mobile:native-back', onBack, capture)
  return () => { view.removeEventListener('dsh-mobile:native-back', onBack, capture) }
}

interface MobileSurface {
  readonly id: string
  readonly placement: MobileSurfacePlacement
  readonly label: string
  mount(container: HTMLElement): void | (() => void)
}
interface MobileClientApi {
  readonly host: {
    invoke(action: string, input: unknown): Promise<unknown>
    fetch(path: string, init?: RequestInit): Promise<Response>
    assetUrl(path: string): string
  }
  readonly ui: {
    registerSurface(surface: MobileSurface): () => void
    open(surfaceId: string): void
    close(surfaceId: string): void
    toast(message: string): void
  }
  readonly native: {
    capabilities(): Promise<readonly string[]>
    invoke(action: string, input?: unknown): Promise<unknown>
  }
  readonly signal: AbortSignal
  readonly document: Document
  readonly window: Window
}
interface MobileClientDefinition {
  readonly apiVersion: 1
  readonly id: string
  activate(api: MobileClientApi): void | (() => void) | Promise<void | (() => void)>
}

declare global {
  interface Window {
    dshMobile?: {
      register(mount: MobileExtensionMount): void
      define(definition: MobileClientDefinition): void
    }
    __DSH_MOBILE_FRONTEND__?: 'dedicated'
    __DSH_MOBILE_NATIVE__?: {
      capabilities(): Promise<readonly string[]> | readonly string[]
      invoke(action: string, input?: unknown): Promise<unknown>
    }
    __DSH_MOBILE_KEYBOARD_STATE__?: { readonly imeVisible: boolean; readonly noHardwareKeyboard: boolean } | null
  }
}

const queuedDefinitions: MobileClientDefinition[] = []
let queuedLegacyMount: MobileExtensionMount | undefined
if (typeof window !== 'undefined' && window.dshMobile === undefined) {
  window.dshMobile = {
    register: mount => { queuedLegacyMount = mount },
    define: definition => { queuedDefinitions.push(definition) },
  }
}

export function selectMobileControlLocale(documentLanguage = '', navigatorLanguages: readonly string[] = []): MobileControlLocale {
  for (const value of [documentLanguage, ...navigatorLanguages]) {
    const language = value.trim().toLowerCase().split(/[-_]/u)[0]
    if (language === 'it' || language === 'en' || language === 'zh') return language
  }
  return 'en'
}

export function selectedMobileControlLocale(): MobileControlLocale {
  return selectMobileControlLocale(document.documentElement.lang, navigator.languages?.length ? navigator.languages : [navigator.language])
}

/**
 * Guidance when an open third-party layer has no safe close action.
 * @param locale - current Mobile UI language.
 * @returns localized guidance.
 */
export function mobileBackBlockedMessage(locale: MobileControlLocale): string {
  const messages: Record<MobileControlLocale, string> = {
    en: 'Close the open panel first.',
    it: 'Chiudi prima il pannello aperto.',
    zh: '请先关闭当前弹层。',
  }
  return messages[locale]
}

/** Remount one plugin-owned surface when DSH changes the document language. */
export function installDshLanguageBoundSurface(install: () => () => void): () => void {
  let locale = selectedMobileControlLocale()
  let dispose = install()
  const observer = new MutationObserver(() => {
    const next = selectedMobileControlLocale()
    if (next === locale) return
    dispose()
    locale = next
    dispose = install()
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  return () => {
    observer.disconnect()
    dispose()
  }
}

function controlTranslator(locale = selectedMobileControlLocale()): (key: string, values?: Readonly<Record<string, string | number>>) => string {
  const messages = MOBILE_CONTROL_MESSAGES as Record<MobileControlLocale, Record<string, string>>
  return (key, values = {}) => {
    const template = messages[locale][key] ?? messages.en[key] ?? key
    return template.replace(/\{(\w+)\}/gu, (_match: string, name: string) => String(values[name] ?? `{${name}}`))
  }
}

export function normalizeDiagnosticOverall(value: unknown): 'ok' | 'attention' | 'error' {
  return value === 'ok' ? 'ok' : value === 'attention' ? 'attention' : 'error'
}

export function normalizeDiagnosticStatus(value: unknown): 'ok' | 'warning' | 'error' | 'info' {
  return value === 'ok' || value === 'warning' || value === 'error' || value === 'info' ? value : 'error'
}

export function diagnosticOverallForChecks(value: unknown, statuses: readonly unknown[]): 'ok' | 'attention' | 'error' {
  const normalized = statuses.map(normalizeDiagnosticStatus)
  const payloadOverall = normalizeDiagnosticOverall(value)
  if (payloadOverall === 'error' || normalized.includes('error')) return 'error'
  if (payloadOverall === 'attention' || normalized.includes('warning')) return 'attention'
  return 'ok'
}

export function validateDiagnosticChecks(value: unknown): { readonly entries: readonly Record<string, unknown>[]; readonly malformed: boolean } {
  if (!Array.isArray(value)) return { entries: [], malformed: true }
  const entries: Record<string, unknown>[] = []
  let malformed = false
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) { malformed = true; continue }
    entries.push(candidate as Record<string, unknown>)
  }
  return { entries, malformed }
}

export function diagnosticEntriesForRender(data: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const overallKnown = data.overall === 'ok' || data.overall === 'attention' || data.overall === 'error'
  const validated = validateDiagnosticChecks(data.checks)
  const statusesKnown = validated.entries.every(entry => entry.status === 'ok' || entry.status === 'warning' || entry.status === 'error' || entry.status === 'info')
  if (!overallKnown || validated.malformed || validated.entries.length === 0 || !statusesKnown) {
    throw new TypeError('diagnostics envelope is unavailable')
  }
  return validated.entries
}

export function renderDiagnosticPayloadSafely(
  data: Record<string, unknown>,
  render: (data: Record<string, unknown>) => void,
  onFailure: (error: unknown) => void,
): void {
  try { render(data) } catch (error) { onFailure(error) }
}

export function diagnosticServerCopy(entry: Readonly<Record<string, unknown>>): { readonly label: string; readonly detail: string; readonly action: string } {
  return {
    label: typeof entry.label === 'string' ? entry.label : '',
    detail: typeof entry.detail === 'string' ? entry.detail : '',
    action: typeof entry.action === 'string' ? entry.action : '',
  }
}

/**
 * Match DSH's client-side privilege hint to the authenticated mobile gateway.
 * The gateway authenticates the paired device and forwards allowed requests to
 * DSH's loopback listener, so settings RPCs receive the same Host-side checks
 * as the desktop page even though the phone's visible URL is a LAN address.
 */
export function trustAuthenticatedGatewayConnection(connection: MobileConnectionHandle): () => void {
  const previous = connection.isLoopback
  connection.isLoopback = true
  return () => { connection.isLoopback = previous }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

interface MobileSwitchComputerCopy {
  readonly title: string
  readonly description: string
  readonly action: string
  readonly busy: string
  readonly retry: string
  readonly error: string
}

function mobileSwitchComputerCopy(locale: MobileControlLocale): MobileSwitchComputerCopy {
  if (locale === 'zh') return {
    title: '切换电脑',
    description: '返回已配对设备列表，选择要打开的电脑。',
    action: '切换电脑',
    busy: '正在切换…',
    retry: '重试',
    error: '切换失败，请重试。',
  }
  if (locale === 'it') return {
    title: 'Cambia computer',
    description: 'Torna all’elenco dei computer associati e scegli quale aprire.',
    action: 'Cambia computer',
    busy: 'Cambio in corso…',
    retry: 'Riprova',
    error: 'Cambio non riuscito. Riprova.',
  }
  return {
    title: 'Switch computer',
    description: 'Return to the paired-device list and choose a computer to open.',
    action: 'Switch computer',
    busy: 'Switching…',
    retry: 'Retry',
    error: 'Could not switch computers. Try again.',
  }
}

/** Render the native-app-only action in DSH's General settings row style. */
function MobileSwitchComputerRow(): unknown {
  const [nativeReady, setNativeReady] = useState(false)
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle')
  useEffect(() => {
    let disposed = false
    const checkNativeAction = (): void => {
      const bridge = window.__DSH_MOBILE_NATIVE__
      if (bridge === undefined) {
        setNativeReady(false)
        return
      }
      void Promise.resolve().then(() => bridge.capabilities()).then(capabilities => {
        if (!disposed) setNativeReady(capabilities.includes('mobile.switch-computer'))
      }, () => {
        if (!disposed) setNativeReady(false)
      })
    }
    checkNativeAction()
    window.addEventListener('dsh-mobile-native-ready', checkNativeAction)
    return () => {
      disposed = true
      window.removeEventListener('dsh-mobile-native-ready', checkNativeAction)
    }
  }, [])
  if (!nativeReady) return null
  const locale = selectedMobileControlLocale()
  const copy = mobileSwitchComputerCopy(locale)
  const invoke = (): void => {
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge === undefined || state === 'busy') return
    setState('busy')
    // The native action normally replaces this WebView immediately; only a
    // rejected request needs to remain visible in the settings row.
    void bridge.invoke('mobile.switch-computer', {}).catch(() => { setState('error') })
  }
  return createElement('div', { className: 'dsh-mobile-settings_row', lang: locale },
    createElement('div', { className: 'dsh-mobile-settings_rowText' },
      createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
      createElement('div', { className: 'dsh-mobile-settings_desc', 'aria-live': 'polite' }, state === 'error' ? copy.error : copy.description),
    ),
    createElement('button', {
      type: 'button',
      className: 'dsh-mobile-settings_selector',
      disabled: state === 'busy',
      'aria-busy': state === 'busy' ? 'true' : undefined,
      onClick: invoke,
    }, state === 'busy' ? copy.busy : state === 'error' ? copy.retry : copy.action),
  )
}

interface MobileTaskNotificationCopy {
  readonly title: string
  readonly description: string
  readonly action: string
  readonly busy: string
  readonly success: string
  readonly reopen: string
  readonly error: string
  readonly retry: string
}

function mobileTaskNotificationCopy(locale: MobileControlLocale): MobileTaskNotificationCopy {
  if (locale === 'zh') return {
    title: '任务通知',
    description: '在 Android 系统中开启任务完成和待确认提醒。',
    action: '通知设置',
    busy: '正在打开…',
    success: '请在系统提示或设置中确认任务通知权限。',
    reopen: '重新打开',
    error: '无法打开通知设置，请重试。',
    retry: '重试',
  }
  if (locale === 'it') return {
    title: 'Notifiche delle attività',
    description: 'Attiva gli avvisi Android per le attività completate o in attesa di conferma.',
    action: 'Impostazioni notifiche',
    busy: 'Apertura…',
    success: 'Conferma il permesso nella richiesta o nelle impostazioni di sistema.',
    reopen: 'Riapri',
    error: 'Impossibile aprire le impostazioni delle notifiche. Riprova.',
    retry: 'Riprova',
  }
  return {
    title: 'Task notifications',
    description: 'Enable Android reminders for completed tasks and pending confirmation.',
    action: 'Notification settings',
    busy: 'Opening…',
    success: 'Confirm notification access in the system prompt or settings.',
    reopen: 'Open again',
    error: 'Could not open notification settings. Try again.',
    retry: 'Retry',
  }
}

/** Render the Android-only notification permission entry in DSH General settings. */
function MobileTaskNotificationRow(): unknown {
  const [nativeReady, setNativeReady] = useState(false)
  const [state, setState] = useState<'idle' | 'busy' | 'success' | 'error'>('idle')
  useEffect(() => {
    let disposed = false
    const checkNativeAction = (): void => {
      const bridge = window.__DSH_MOBILE_NATIVE__
      if (bridge === undefined) {
        setNativeReady(false)
        return
      }
      void Promise.resolve().then(() => bridge.capabilities()).then(capabilities => {
        if (!disposed) setNativeReady(capabilities.includes('notification.settings'))
      }, () => {
        if (!disposed) setNativeReady(false)
      })
    }
    checkNativeAction()
    window.addEventListener('dsh-mobile-native-ready', checkNativeAction)
    return () => {
      disposed = true
      window.removeEventListener('dsh-mobile-native-ready', checkNativeAction)
    }
  }, [])
  if (!nativeReady) return null
  const locale = selectedMobileControlLocale()
  const copy = mobileTaskNotificationCopy(locale)
  const invoke = (): void => {
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge === undefined || state === 'busy') return
    setState('busy')
    void bridge.invoke('notification.settings', {}).then(
      () => { setState('success') },
      () => { setState('error') },
    )
  }
  return createElement('div', { className: 'dsh-mobile-settings_row', lang: locale },
    createElement('div', { className: 'dsh-mobile-settings_rowText' },
      createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
      createElement('div', { className: 'dsh-mobile-settings_desc', 'aria-live': 'polite' },
        state === 'success' ? copy.success : state === 'error' ? copy.error : copy.description),
    ),
    createElement('button', {
      type: 'button',
      className: 'dsh-mobile-settings_selector',
      disabled: state === 'busy',
      'aria-busy': state === 'busy' ? 'true' : undefined,
      onClick: invoke,
    }, state === 'busy' ? copy.busy : state === 'success' ? copy.reopen : state === 'error' ? copy.retry : copy.action),
  )
}

const CONTROL_REQUEST_TIMEOUT_MS = 15_000
const LONG_CONTROL_REQUEST_TIMEOUT_MS = 210_000
const GITHUB_RELEASES_URL = 'https://github.com/saya-ch/dsh-mobile/releases'
const CONTROL_PANEL_ID = 'dsh-mobile-control-panel'

export interface ClientReleaseInfo {
  readonly updateAvailable: boolean
  readonly latestVersion?: string
  readonly androidVersion?: string
  readonly androidDownloadUrl: string
  /** Trimmed release notes body for the preview card (best effort). */
  readonly releaseNotes?: string
}

function releaseVersion(value: unknown): string | undefined {
  return typeof value === 'string'
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
    ? value
    : undefined
}

/** Reduce the loopback release response to trusted text and download metadata. */
export function clientReleaseInfo(data: Readonly<Record<string, unknown>>): ClientReleaseInfo {
  const latestVersion = releaseVersion(data.latestVersion)
  const androidVersion = releaseVersion(data.androidVersion)
  const expectedAndroidDownloadUrls = androidVersion === undefined
    ? []
    : ['v', 'android-v'].map(prefix => `${GITHUB_RELEASES_URL}/download/${prefix}${androidVersion}/dsh-mobile-android-v${androidVersion}.apk`)
  const androidDownloadUrl = typeof data.androidDownloadUrl === 'string' && expectedAndroidDownloadUrls.includes(data.androidDownloadUrl)
    ? data.androidDownloadUrl
    : GITHUB_RELEASES_URL
  return {
    updateAvailable: data.updateAvailable === true && latestVersion !== undefined,
    ...(latestVersion === undefined ? {} : { latestVersion }),
    ...(androidVersion === undefined ? {} : { androidVersion }),
    androidDownloadUrl,
    ...(typeof data.releaseNotes === 'string' && data.releaseNotes !== '' ? { releaseNotes: data.releaseNotes.slice(0, 4000) } : {}),
  }
}

async function requestJson(
  path: string,
  init?: RequestInit,
  timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const upstreamSignal = init?.signal
  const abortFromUpstream = (): void => { controller.abort(upstreamSignal?.reason) }
  if (upstreamSignal?.aborted === true) abortFromUpstream()
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
  const timer = window.setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: localAdminRequestHeaders(init, location),
    })
    const body = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
    return body
  } catch (error) {
    if (controller.signal.aborted && upstreamSignal?.aborted !== true) {
      throw new Error(controlTranslator()('requestTimeout'))
    }
    throw error
  } finally {
    clearTimeout(timer)
    upstreamSignal?.removeEventListener('abort', abortFromUpstream)
  }
}

/** Provider failure codes shared by status, failed requests, and diagnostics. */
const REMOTE_ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  cloudflared_path_invalid: 'componentPathUnsafe',
  cloudflared_tunnel_path_invalid: 'componentPathUnsafe',
  sakurafrp_path_invalid: 'componentPathUnsafe',
  sakurafrp_config_path_invalid: 'componentPathUnsafe',
  gateway_start_failed: 'gatewayStartFailed',
  control_channel_failed: 'controlChannelFailed',
  cloudflared_component_missing: 'cloudflaredMissing',
  cloudflared_component_invalid: 'cloudflaredInvalid',
  cloudflared_port_unavailable: 'cloudflaredPortUnavailable',
  cloudflared_launch_failed: 'cloudflaredLaunchFailed',
  cloudflared_start_timeout: 'cloudflaredTimeout',
  cloudflared_stopped: 'cloudflaredStopped',
  cloudflared_exited: 'cloudflaredExited',
  cloudflared_invalid_output: 'cloudflaredOutputInvalid',
  cloudflared_invalid_origin: 'cloudflaredOriginInvalid',
  cloudflared_tunnel_port_unavailable: 'cloudflaredTunnelPortUnavailable',
  cloudflared_tunnel_hostname_invalid: 'cloudflaredTunnelHostnameInvalid',
  cloudflared_tunnel_port_invalid: 'cloudflaredTunnelPortInvalid',
  cloudflared_tunnel_port_reserved: 'cloudflaredTunnelPortReserved',
  cloudflared_tunnel_token_invalid: 'cloudflaredTunnelTokenInvalid',
  cloudflared_tunnel_settings_invalid: 'cloudflaredTunnelSettingsInvalid',
  cloudflared_tunnel_config_missing: 'cloudflaredTunnelConfigMissing',
  cloudflared_tunnel_config_invalid: 'cloudflaredTunnelInvalid',
  cloudflared_tunnel_target_invalid: 'cloudflaredTunnelTargetInvalid',
  cloudflared_component_unsupported: 'cloudflaredComponentUnsupported',
  cloudflared_download_hash_mismatch: 'cloudflaredDownloadHashMismatch',
  cloudflared_download_size_mismatch: 'cloudflaredDownloadSizeMismatch',
  cloudflared_executable_hash_mismatch: 'cloudflaredExecutableHashMismatch',
  cloudflared_download_redirect_missing: 'cloudflaredDownloadRedirectMissing',
  cloudflared_download_redirect_invalid: 'cloudflaredDownloadRedirectInvalid',
  cloudflared_download_redirect_rejected: 'cloudflaredDownloadRedirectRejected',
  cloudflared_port_reservation_failed: 'cloudflaredPortReservationFailed',
  sakurafrp_token_missing: 'sakuraTokenMissing',
  sakurafrp_token_invalid: 'sakuraTokenInvalid',
  sakurafrp_api_unreachable: 'sakuraApiUnreachable',
  sakurafrp_api_error: 'sakuraApiError',
  sakurafrp_tunnel_missing: 'sakuraTunnelMissing',
  sakurafrp_tunnel_banned: 'sakuraTunnelBanned',
  sakurafrp_tunnel_type_unsupported: 'sakuraTunnelTypeUnsupported',
  sakurafrp_tunnel_locked: 'sakuraTunnelLocked',
  sakurafrp_tunnel_port_unavailable: 'sakuraTunnelPortUnavailable',
  sakurafrp_entry_unknown: 'sakuraEntryUnknown',
  sakurafrp_component_missing: 'sakuraFrpcMissing',
  sakurafrp_component_invalid: 'sakuraFrpcInvalid',
  sakurafrp_config_fetch_failed: 'sakuraConfigFetchFailed',
  sakurafrp_launch_failed: 'sakuraLaunchFailed',
  sakurafrp_start_timeout: 'sakuraStartTimeout',
  sakurafrp_stopped: 'sakuraStopped',
  sakurafrp_exited: 'sakuraExited',
  sakurafrp_invalid_output: 'sakuraInvalidOutput',
  sakurafrp_settings_invalid: 'sakuraSettingsInvalid',
  sakurafrp_port_reservation_failed: 'sakuraPortReservationFailed',
  remote_component_launch_failed: 'remoteComponentLaunchFailed',
}

const DIAGNOSTIC_CONTROLLER_ACTION_CODES: ReadonlySet<string> = new Set([
  'control_channel_failed', 'gateway_start_failed',
  'cloudflared_component_missing', 'cloudflared_component_invalid', 'cloudflared_component_unsupported',
  'cloudflared_port_unavailable', 'cloudflared_port_reservation_failed', 'cloudflared_launch_failed',
  'cloudflared_start_timeout', 'cloudflared_stopped', 'cloudflared_exited', 'cloudflared_invalid_origin',
  'cloudflared_tunnel_port_unavailable', 'cloudflared_tunnel_config_invalid', 'cloudflared_tunnel_target_invalid',
  'cloudflared_download_hash_mismatch', 'cloudflared_download_size_mismatch', 'cloudflared_executable_hash_mismatch',
  'sakurafrp_token_missing', 'sakurafrp_token_invalid', 'sakurafrp_api_unreachable', 'sakurafrp_api_error',
  'sakurafrp_tunnel_missing', 'sakurafrp_tunnel_banned', 'sakurafrp_tunnel_type_unsupported',
  'sakurafrp_tunnel_locked', 'sakurafrp_tunnel_port_unavailable', 'sakurafrp_entry_unknown',
  'sakurafrp_component_missing', 'sakurafrp_component_invalid', 'sakurafrp_config_fetch_failed',
  'sakurafrp_launch_failed', 'sakurafrp_start_timeout', 'sakurafrp_stopped', 'sakurafrp_exited',
  'sakurafrp_invalid_output', 'sakurafrp_settings_invalid', 'sakurafrp_port_reservation_failed',
  'remote_component_launch_failed',
])

/** Resolve the next-step text for a remote-controller diagnostic. */
export function diagnosticControllerAction(code: unknown, locale: MobileControlLocale, fallback: string): string {
  if (typeof code !== 'string') return fallback
  const key = DIAGNOSTIC_CONTROLLER_ACTION_CODES.has(code) ? REMOTE_ERROR_MESSAGE_KEYS[code] : undefined
  return key === undefined ? fallback : controlTranslator(locale)(key)
}

function installControl(): { remove: () => void; toggle: () => void; isOpen: () => boolean } {

  /** The table above, translated, for the status repaint. */
  const translatedRemoteErrors = (): Record<string, string> =>
    Object.fromEntries(Object.entries(REMOTE_ERROR_MESSAGE_KEYS).map(([code, key]) => [code, t(key)]))

  /**
   * Text for a failed control request.
   *
   * A rejection carries its code in `error.message`, so a known code renders its
   * translated sentence; only an unrecognized one falls back to the generic message,
   * and it shows the bare message rather than a stringified Error.
   */
  const remoteFailureTextFor = (error: unknown, fallbackKey: string): string => {
    const message = error instanceof Error ? error.message : String(error)
    const key = REMOTE_ERROR_MESSAGE_KEYS[message]
    return key === undefined ? t(fallbackKey, { error: message }) : t(key)
  }
  const locale = selectedMobileControlLocale()
  const localeTag = locale === 'it' ? 'it-IT' : locale === 'zh' ? 'zh-CN' : 'en-US'
  const t = controlTranslator(locale)
  const lifecycle = new AbortController()
  const controlRequestJson = (path: string, init?: RequestInit, timeoutMs?: number): Promise<Record<string, unknown>> => requestJson(path, { ...init, signal: lifecycle.signal }, timeoutMs)
  const extensionRecovery = installExtensionRecoveryControl({ document, signal: lifecycle.signal, request: controlRequestJson, confirm: message => window.confirm(message), translate: t })
  const root = element('div', 'dsh-mobile-control'); root.lang = locale
  // The settings surface is a centered modal window, not a sidebar-anchored
  // card. The wrapper follows DSH's dialog pattern (presentation wrapper with
  // exactly an aria-hidden mask and the dialog) so the Android/native Back
  // layer can dismiss it through mask.click() like any other DSH dialog.
  const windowBox = element('div', 'dsh-mobile-control__window'); windowBox.setAttribute('role', 'presentation')
  const backdrop = element('div', 'dsh-mobile-control__backdrop'); backdrop.hidden = true; backdrop.setAttribute('aria-hidden', 'true')
  const panel = element('section', 'dsh-mobile-control__panel'); panel.id = CONTROL_PANEL_ID; panel.hidden = true; panel.lang = locale
  panel.tabIndex = -1
  panel.setAttribute('aria-label', t('mobileAccess'))
  const header = element('header', 'dsh-mobile-control__header')
  const title = element('h2'); title.textContent = t('mobileAccess')
  const headerActions = element('div', 'dsh-mobile-control__header-actions')
  const updatePlugin = element('button', 'dsh-mobile-control__update-plugin'); updatePlugin.type = 'button'; updatePlugin.textContent = t('updatePlugin'); updatePlugin.hidden = true
  // Preview card shown before applying an update: what’s new + notices, then confirm.
  const updateCard = element('div', 'dsh-mobile-control__update-card'); updateCard.hidden = true
  const updateCardTitle = element('div', 'dsh-mobile-control__update-card-title')
  const updateCardNotes = element('pre', 'dsh-mobile-control__update-notes'); updateCardNotes.setAttribute('tabindex', '0')
  const updateCardNotice = element('p', 'dsh-mobile-control__update-notice'); updateCardNotice.textContent = t('updateNotice')
  const updateActions = element('div', 'dsh-mobile-control__update-actions')
  const updateNow = element('button', 'dsh-mobile-control__primary'); updateNow.type = 'button'; updateNow.textContent = t('updateNow')
  const updateLater = element('button', 'dsh-mobile-control__secondary'); updateLater.type = 'button'; updateLater.textContent = t('updateLater')
  updateActions.append(updateLater, updateNow); updateCard.append(updateCardTitle, updateCardNotes, updateCardNotice, updateActions)
  const diagnosticsEntry = element('button', 'dsh-mobile-control__diagnostic-entry'); diagnosticsEntry.type = 'button'; diagnosticsEntry.textContent = t('diagnostics'); diagnosticsEntry.setAttribute('aria-label', t('openDiagnostics')); diagnosticsEntry.setAttribute('aria-pressed', 'false')
  const close = element('button', 'dsh-mobile-control__close'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', t('collapseMobileAccess'))
  headerActions.append(updatePlugin, diagnosticsEntry, close)
  const releaseNotice = element('p', 'dsh-mobile-control__release-notice'); releaseNotice.hidden = true; releaseNotice.setAttribute('role', 'status'); releaseNotice.setAttribute('aria-live', 'polite')
  const appDownload = element('a', 'dsh-mobile-control__app-download'); appDownload.href = GITHUB_RELEASES_URL; appDownload.target = '_blank'; appDownload.rel = 'noopener noreferrer'; appDownload.textContent = t('downloadAndroid'); appDownload.setAttribute('aria-label', t('downloadAndroidAria'))
  const switcher = element('div', 'dsh-mobile-control__switcher')
  const lanTab = element('button', 'dsh-mobile-control__tab is-active'); lanTab.type = 'button'; lanTab.textContent = t('lan')
  const remoteTab = element('button', 'dsh-mobile-control__tab'); remoteTab.type = 'button'; remoteTab.textContent = t('remote')
  lanTab.setAttribute('aria-pressed', 'true'); remoteTab.setAttribute('aria-pressed', 'false'); switcher.append(lanTab, remoteTab)
  const lanView = element('div', 'dsh-mobile-control__view')
  const lanSetup = element('section', 'dsh-mobile-control__lan-setup'); lanSetup.hidden = true
  const lanSetupTitle = element('h3', 'dsh-mobile-control__section-title'); lanSetupTitle.textContent = t('lanSetupTitle')
  const lanSetupIntro = element('p', 'dsh-mobile-control__intro'); lanSetupIntro.textContent = t('lanSetupIntro')
  const lanSetupForm = element('div', 'dsh-mobile-control__lan-setup-form')
  const lanSetupLabel = element('label', 'dsh-mobile-control__field'); lanSetupLabel.textContent = t('lanSetupNetwork')
  const lanSetupSelect = element('select'); lanSetupSelect.setAttribute('aria-label', t('lanSetupNetwork'))
  const lanSetupNote = element('p', 'dsh-mobile-control__component-note'); lanSetupNote.textContent = t('lanSetupFirewallNote')
  const lanSetupActions = element('div', 'dsh-mobile-control__lan-setup-actions')
  const lanSetupRefresh = element('button', 'dsh-mobile-control__secondary'); lanSetupRefresh.type = 'button'; lanSetupRefresh.textContent = t('lanSetupRefresh')
  const lanSetupConfigure = element('button', 'dsh-mobile-control__primary'); lanSetupConfigure.type = 'button'; lanSetupConfigure.textContent = t('lanSetupConfigure')
  const lanSetupStatus = element('p', 'dsh-mobile-control__status'); lanSetupStatus.setAttribute('role', 'status'); lanSetupStatus.setAttribute('aria-live', 'polite')
  const trustedNetworks = element('details', 'dsh-mobile-control__details')
  const trustedNetworksSummary = element('summary'); trustedNetworksSummary.textContent = t('trustedNetworksTitle')
  const trustedNetworksHelp = element('p', 'dsh-mobile-control__component-note'); trustedNetworksHelp.textContent = t('trustedNetworksHelp')
  const trustedNetworksLabel = element('label', 'dsh-mobile-control__field'); trustedNetworksLabel.textContent = t('trustedNetworksLabel')
  const trustedNetworksInput = element('textarea'); trustedNetworksInput.rows = 2; trustedNetworksInput.placeholder = '11.24.0.0/24\n2001:db8::/32'; trustedNetworksInput.autocomplete = 'off'; trustedNetworksInput.spellcheck = false
  const trustedNetworksSave = element('button', 'dsh-mobile-control__secondary'); trustedNetworksSave.type = 'button'; trustedNetworksSave.textContent = t('trustedNetworksSave')
  const trustedNetworksStatus = element('p', 'dsh-mobile-control__status'); trustedNetworksStatus.setAttribute('role', 'status'); trustedNetworksStatus.setAttribute('aria-live', 'polite')
  trustedNetworksLabel.append(trustedNetworksInput); trustedNetworks.append(trustedNetworksSummary, trustedNetworksHelp, trustedNetworksLabel, trustedNetworksSave, trustedNetworksStatus)
  let trustedNetworksLoaded = false
  let trustedNetworksLoading = false
  let trustedNetworksSupported = false
  let trustedNetworksDirty = false
  let trustedNetworksBusy = false
  const syncTrustedNetworksControls = (): void => {
    const enabled = trustedNetworksLoaded && trustedNetworksSupported && !trustedNetworksLoading && !trustedNetworksBusy
    trustedNetworksInput.disabled = !enabled
    trustedNetworksSave.disabled = !enabled
    trustedNetworks.setAttribute('aria-busy', String(trustedNetworksLoading || trustedNetworksBusy))
  }
  syncTrustedNetworksControls()
  const renderTrustedNetworks = (data: Record<string, unknown>): void => {
    trustedNetworksLoaded = true
    trustedNetworksSupported = data.supported === true
    syncTrustedNetworksControls()
    if (!trustedNetworksDirty) trustedNetworksInput.value = Array.isArray(data.extraAllowedCidrs) ? data.extraAllowedCidrs.filter(value => typeof value === 'string').join('\n') : ''
    trustedNetworksStatus.textContent = !trustedNetworksSupported ? t('trustedNetworksUnavailable') : data.restartRequired === true ? t('trustedNetworksRestart') : ''
    trustedNetworksHelp.textContent = `${t('trustedNetworksHelp')}${data.windowsFirewall === true ? ` ${t('trustedNetworksWindows')}` : ''}`
  }
  trustedNetworks.addEventListener('toggle', () => {
    if (!trustedNetworks.open || trustedNetworksLoaded || trustedNetworksLoading) return
    trustedNetworksLoading = true
    syncTrustedNetworksControls()
    trustedNetworksStatus.textContent = t('loadingStatus')
    void controlRequestJson('/api/mobile-access/lan/trusted-networks').then(renderTrustedNetworks, () => {
      trustedNetworksLoaded = false; trustedNetworksSupported = false; trustedNetworksStatus.textContent = t('trustedNetworksFailed')
    }).finally(() => { trustedNetworksLoading = false; syncTrustedNetworksControls() })
  })
  trustedNetworksInput.addEventListener('input', () => { trustedNetworksDirty = true; trustedNetworksInput.removeAttribute('aria-invalid') })
  trustedNetworksSave.addEventListener('click', () => {
    if (trustedNetworksBusy || !trustedNetworksLoaded || !trustedNetworksSupported) return
    trustedNetworksBusy = true; syncTrustedNetworksControls()
    const extraAllowedCidrs = trustedNetworksInput.value.trim().split(/[\s,]+/u).filter(Boolean)
    void controlRequestJson('/api/mobile-access/lan/trusted-networks', { method: 'POST', body: JSON.stringify({ extraAllowedCidrs }) }).then(data => {
      trustedNetworksDirty = false; renderTrustedNetworks(data)
    }, () => { trustedNetworksStatus.textContent = t('trustedNetworksInvalid'); trustedNetworksInput.setAttribute('aria-invalid', 'true') }).finally(() => {
      trustedNetworksBusy = false; syncTrustedNetworksControls()
    })
  })
  lanSetupLabel.append(lanSetupSelect); lanSetupActions.append(lanSetupRefresh, lanSetupConfigure); lanSetupForm.append(lanSetupLabel, lanSetupNote, lanSetupActions); lanSetup.append(lanSetupTitle, lanSetupIntro, lanSetupForm, lanSetupStatus)
  const access = element('div', 'dsh-mobile-control__access'); access.hidden = true
  const accessLabel = element('span', 'dsh-mobile-control__access-label'); accessLabel.textContent = t('browserAccess')
  const accessLink = element('a', 'dsh-mobile-control__access-link'); accessLink.target = '_blank'; accessLink.rel = 'noreferrer'
  access.append(accessLabel, accessLink)
  const qrBox = element('div', 'dsh-mobile-control__qr'); qrBox.hidden = true
  const status = element('p', 'dsh-mobile-control__status'); status.textContent = t('loadingStatus')
  const extensionStatus = element('p', 'dsh-mobile-control__extensions'); extensionStatus.hidden = true
  const actions = element('div', 'dsh-mobile-control__actions')
  const toggle = element('button', 'dsh-mobile-control__secondary'); toggle.type = 'button'
  const pair = element('button', 'dsh-mobile-control__primary'); pair.type = 'button'; pair.textContent = t('generateCopyKey')
  const linkPair = element('button', 'dsh-mobile-control__secondary'); linkPair.type = 'button'; linkPair.textContent = t('copyPairLink')
  const manageRow = element('div', 'dsh-mobile-control__manage-row')
  const manageDevices = element('button', 'dsh-mobile-control__manage'); manageDevices.type = 'button'; manageDevices.textContent = t('managePairedDevices')
  const resetAll = element('button', 'dsh-mobile-control__manage'); resetAll.type = 'button'; resetAll.textContent = t('clearAllDevices')
  manageRow.append(manageDevices, resetAll)
  const devicePanel = element('div', 'dsh-mobile-control__devices'); devicePanel.hidden = true
  const remoteView = element('div', 'dsh-mobile-control__view is-remote'); remoteView.hidden = true
  const remoteIntro = element('p', 'dsh-mobile-control__intro'); remoteIntro.textContent = t('remoteIntro')
  const httpFrameWarning = element('p', 'dsh-mobile-control__http-frame-warning'); httpFrameWarning.textContent = t('httpFrameWarning'); httpFrameWarning.hidden = location.protocol !== 'https:'; httpFrameWarning.setAttribute('role', 'note')
  const providerSection = element('section', 'dsh-mobile-control__provider-section')
  const providerHeading = element('h3', 'dsh-mobile-control__section-title'); providerHeading.textContent = t('chooseProvider')
  const providerInfo = element('div', 'dsh-mobile-control__provider-info')
  const providerInfoButton = element('button', 'dsh-mobile-control__provider-info-button'); providerInfoButton.type = 'button'; providerInfoButton.setAttribute('aria-label', t('providerInfoAria')); providerInfoButton.setAttribute('aria-expanded', 'false'); providerInfoButton.setAttribute('aria-controls', 'dsh-mobile-provider-info'); providerInfoButton.setAttribute('aria-describedby', 'dsh-mobile-provider-info')
  const providerInfoGlyph = element('span', 'dsh-mobile-control__provider-info-glyph'); providerInfoGlyph.textContent = 'i'; providerInfoGlyph.setAttribute('aria-hidden', 'true')
  const providerInfoPopover = element('div', 'dsh-mobile-control__provider-info-popover'); providerInfoPopover.id = 'dsh-mobile-provider-info'; providerInfoPopover.setAttribute('role', 'tooltip'); providerInfoPopover.hidden = true
  const providerInfoTitle = element('strong'); providerInfoTitle.textContent = t('providerSafeTitle')
  const providerInfoText = element('span'); providerInfoText.textContent = t('providerSafeText')
  providerInfoButton.append(providerInfoGlyph); providerInfoPopover.append(providerInfoTitle, providerInfoText); providerInfo.append(providerInfoButton, providerInfoPopover)
  const providerChoices = element('div', 'dsh-mobile-control__provider-choices'); providerChoices.setAttribute('role', 'radiogroup'); providerChoices.setAttribute('aria-label', t('providerGroupAria'))
  const cloudflaredChoice = element('button', 'dsh-mobile-control__provider'); cloudflaredChoice.type = 'button'; cloudflaredChoice.setAttribute('role', 'radio'); cloudflaredChoice.setAttribute('aria-checked', 'false')
  const cloudflaredChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const cloudflaredChoiceName = element('strong'); cloudflaredChoiceName.textContent = 'cloudflared'
  const cloudflaredChoiceBadge = element('span', 'dsh-mobile-control__provider-badge'); cloudflaredChoiceBadge.textContent = t('cloudflaredBadge')
  const cloudflaredChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); cloudflaredChoiceDescription.textContent = t('cloudflaredDescription')
  cloudflaredChoiceTop.append(cloudflaredChoiceName, cloudflaredChoiceBadge); cloudflaredChoice.append(cloudflaredChoiceTop, cloudflaredChoiceDescription)
  const sakuraChoice = element('button', 'dsh-mobile-control__provider'); sakuraChoice.type = 'button'; sakuraChoice.setAttribute('role', 'radio'); sakuraChoice.setAttribute('aria-checked', 'false')
  const sakuraChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const sakuraChoiceName = element('strong'); sakuraChoiceName.textContent = 'SakuraFrp'
  const sakuraChoiceBadge = element('span', 'dsh-mobile-control__provider-badge is-cpolar'); sakuraChoiceBadge.textContent = t('mainlandPreferred')
  const sakuraChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); sakuraChoiceDescription.textContent = t('sakuraDescription')
  sakuraChoiceTop.append(sakuraChoiceName, sakuraChoiceBadge); sakuraChoice.append(sakuraChoiceTop, sakuraChoiceDescription)
  providerChoices.append(cloudflaredChoice, sakuraChoice)
  // ARIA radios normally move focus and selection together, but choosing a provider switches
  // the remote channel behind a confirmation. The arrow keys therefore move focus only, Enter
  // or Space performs the guarded selection, and the group keeps a single tab stop.
  const providerCardOrder = [cloudflaredChoice, sakuraChoice]
  providerChoices.addEventListener('keydown', event => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    const jump = event.key === 'Home' ? 0 : event.key === 'End' ? providerCardOrder.length - 1 : undefined
    if (step === 0 && jump === undefined) return
    const current = providerCardOrder.indexOf(document.activeElement as HTMLButtonElement)
    if (current < 0) return
    const next = jump ?? (current + step + providerCardOrder.length) % providerCardOrder.length
    event.preventDefault()
    providerCardOrder[next]?.focus()
  })
  // SakuraFrp reuses the managed-component setup card: an access key, a TCP
  // tunnel list, and the frpc component install/cleanup disclosure.
  const sakuraSetup = element('section', 'dsh-mobile-control__cpolar-setup dsh-mobile-control__sakurafrp-setup'); sakuraSetup.hidden = true
  const sakuraSetupTitle = element('h3', 'dsh-mobile-control__section-title'); sakuraSetupTitle.textContent = t('prepareSakurafrp')
  const sakuraTokenNote = element('p', 'dsh-mobile-control__component-note'); sakuraTokenNote.textContent = t('sakuraTokenNote')
  const sakuraPanelLink = element('a', 'dsh-mobile-control__text-link'); sakuraPanelLink.href = 'https://www.natfrp.com/user/'; sakuraPanelLink.target = '_blank'; sakuraPanelLink.rel = 'noopener noreferrer'; sakuraPanelLink.textContent = t('sakuraPanelLink')
  const sakuraTokenLabel = element('label', 'dsh-mobile-control__token-label'); sakuraTokenLabel.textContent = t('sakuraTokenLabel')
  const sakuraToken = element('input', 'dsh-mobile-control__token'); sakuraToken.type = 'password'; sakuraToken.autocomplete = 'off'; sakuraToken.spellcheck = false; sakuraToken.placeholder = t('tokenPlaceholder'); sakuraTokenLabel.append(sakuraToken)
  const sakuraTokenSave = element('button', 'dsh-mobile-control__primary dsh-mobile-control__cpolar-connect'); sakuraTokenSave.type = 'button'; sakuraTokenSave.textContent = t('saveToken')
  const sakuraTunnelsTitle = element('h3', 'dsh-mobile-control__section-title'); sakuraTunnelsTitle.textContent = t('sakuraTunnelsTitle')
  const sakuraTunnelStatus = element('p', 'dsh-mobile-control__component-status'); sakuraTunnelStatus.textContent = ''
  const sakuraTunnelRow = element('div', 'dsh-mobile-control__ws-paths-row')
  const sakuraTunnelSelect = element('select', 'dsh-mobile-control__ws-paths-input'); sakuraTunnelSelect.setAttribute('aria-label', t('sakuraTunnelSelect'))
  const sakuraTunnelRefresh = element('button', 'dsh-mobile-control__primary'); sakuraTunnelRefresh.type = 'button'; sakuraTunnelRefresh.textContent = t('sakuraTunnelsRefresh')
  sakuraTunnelRow.append(sakuraTunnelSelect, sakuraTunnelRefresh)
  const sakuraTunnelHint = element('p', 'dsh-mobile-control__frp-hint'); sakuraTunnelHint.textContent = t('sakuraTunnelEmpty')
  const sakuraConfigure = element('button', 'dsh-mobile-control__primary dsh-mobile-control__frp-action'); sakuraConfigure.type = 'button'; sakuraConfigure.textContent = t('sakuraConfigureSave')
  const sakuraComponentStatus = element('p', 'dsh-mobile-control__component-status'); sakuraComponentStatus.textContent = t('checkingComponent')
  const sakuraInstall = element('button', 'dsh-mobile-control__primary'); sakuraInstall.type = 'button'; sakuraInstall.textContent = t('installFrpc')
  const sakuraDetails = element('details', 'dsh-mobile-control__details')
  const sakuraDetailsSummary = element('summary'); sakuraDetailsSummary.textContent = t('componentDetails')
  const sakuraDetailsBody = element('div', 'dsh-mobile-control__details-body')
  const sakuraDetailsText = element('p'); sakuraDetailsText.textContent = t('componentDetailsText')
  const sakuraStorage = element('code', 'dsh-mobile-control__storage'); sakuraStorage.textContent = t('pluginPrivateDirectory')
  const sakuraOfficial = element('a', 'dsh-mobile-control__text-link'); sakuraOfficial.href = 'https://www.natfrp.com/'; sakuraOfficial.target = '_blank'; sakuraOfficial.rel = 'noopener noreferrer'; sakuraOfficial.textContent = t('officialDownload')
  const sakuraPurge = element('button', 'dsh-mobile-control__danger'); sakuraPurge.type = 'button'; sakuraPurge.textContent = t('sakuraPurge')
  sakuraDetailsBody.append(sakuraDetailsText, sakuraStorage, sakuraOfficial, sakuraPurge); sakuraDetails.append(sakuraDetailsSummary, sakuraDetailsBody)
  sakuraSetup.append(sakuraSetupTitle, sakuraTokenNote, sakuraPanelLink, sakuraTokenLabel, sakuraTokenSave, sakuraTunnelsTitle, sakuraTunnelStatus, sakuraTunnelRow, sakuraTunnelHint, sakuraConfigure, sakuraComponentStatus, sakuraInstall, sakuraDetails)
  // The cloudflared provider now runs named tunnels only, so the setup card keeps
  // the saved tunnel fields and the component install/cleanup disclosure.
  const cloudflaredSetup = element('section', 'dsh-mobile-control__cpolar-setup dsh-mobile-control__cloudflared-setup'); cloudflaredSetup.hidden = true
  const cloudflaredSetupTitle = element('h3', 'dsh-mobile-control__section-title'); cloudflaredSetupTitle.textContent = t('prepareCloudflared')
  const cloudflaredTunnel = element('div', 'dsh-mobile-control__tunnel')
  const cloudflaredTunnelFields = element('div', 'dsh-mobile-control__frp-fields')
  const cloudflaredHostnameLabel = element('label', 'dsh-mobile-control__field'); cloudflaredHostnameLabel.textContent = t('cloudflaredTunnelHostname')
  const cloudflaredHostname = element('input'); cloudflaredHostname.type = 'text'; cloudflaredHostname.autocomplete = 'off'; cloudflaredHostname.spellcheck = false; cloudflaredHostname.placeholder = t('cloudflaredTunnelHostnamePlaceholder')
  const cloudflaredPortLabel = element('label', 'dsh-mobile-control__field'); cloudflaredPortLabel.textContent = t('cloudflaredTunnelPort')
  const cloudflaredPort = element('input'); cloudflaredPort.type = 'number'; cloudflaredPort.inputMode = 'numeric'; cloudflaredPort.min = '1024'; cloudflaredPort.max = '65535'; cloudflaredPort.value = '3444'
  const cloudflaredTokenLabel = element('label', 'dsh-mobile-control__field'); cloudflaredTokenLabel.textContent = t('cloudflaredTunnelToken')
  const cloudflaredToken = element('input'); cloudflaredToken.type = 'password'; cloudflaredToken.autocomplete = 'off'; cloudflaredToken.spellcheck = false; cloudflaredToken.placeholder = t('cloudflaredTunnelTokenPlaceholder')
  cloudflaredHostnameLabel.append(cloudflaredHostname); cloudflaredPortLabel.append(cloudflaredPort); cloudflaredTokenLabel.append(cloudflaredToken)
  cloudflaredTunnelFields.append(cloudflaredHostnameLabel, cloudflaredPortLabel, cloudflaredTokenLabel)
  const cloudflaredTunnelStatus = element('p', 'dsh-mobile-control__component-status'); cloudflaredTunnelStatus.textContent = t('cloudflaredTunnelMissing')
  const cloudflaredTunnelHint = element('p', 'dsh-mobile-control__component-status'); cloudflaredTunnelHint.textContent = t('cloudflaredTunnelHint', { port: '3444' })
  const cloudflaredTunnelSave = element('button', 'dsh-mobile-control__primary dsh-mobile-control__frp-action'); cloudflaredTunnelSave.type = 'button'; cloudflaredTunnelSave.textContent = t('cloudflaredTunnelSave')
  const cloudflaredTunnelForget = element('button', 'dsh-mobile-control__danger dsh-mobile-control__frp-action'); cloudflaredTunnelForget.type = 'button'; cloudflaredTunnelForget.textContent = t('cloudflaredTunnelForget'); cloudflaredTunnelForget.hidden = true
  // Only the named-tunnel inputs live in this container. Save stays outside it:
  // hiding the container must never take the only way to submit the form with it.
  cloudflaredTunnel.append(cloudflaredTunnelFields, cloudflaredTunnelStatus, cloudflaredTunnelHint)
  const cloudflaredComponentStatus = element('p', 'dsh-mobile-control__component-status'); cloudflaredComponentStatus.textContent = t('checkingComponent')
  const cloudflaredInstall = element('button', 'dsh-mobile-control__primary'); cloudflaredInstall.type = 'button'; cloudflaredInstall.textContent = t('installOfficial')
  const cloudflaredNote = element('p', 'dsh-mobile-control__origin-warning'); cloudflaredNote.textContent = t('cloudflaredNamedNote')
  const cloudflaredDetails = element('details', 'dsh-mobile-control__details')
  const cloudflaredDetailsSummary = element('summary'); cloudflaredDetailsSummary.textContent = t('componentDetails')
  const cloudflaredDetailsBody = element('div', 'dsh-mobile-control__details-body')
  const cloudflaredDetailsText = element('p'); cloudflaredDetailsText.textContent = t('cloudflaredComponentNote')
  const cloudflaredStorage = element('code', 'dsh-mobile-control__storage'); cloudflaredStorage.textContent = t('pluginPrivateDirectory')
  const cloudflaredOfficial = element('a', 'dsh-mobile-control__text-link'); cloudflaredOfficial.href = 'https://github.com/cloudflare/cloudflared/releases'; cloudflaredOfficial.target = '_blank'; cloudflaredOfficial.rel = 'noopener noreferrer'; cloudflaredOfficial.textContent = t('officialDownload')
  const cloudflaredTerms = element('a', 'dsh-mobile-control__text-link'); cloudflaredTerms.href = 'https://www.cloudflare.com/website-terms/'; cloudflaredTerms.target = '_blank'; cloudflaredTerms.rel = 'noopener noreferrer'; cloudflaredTerms.textContent = t('terms')
  const cloudflaredPurge = element('button', 'dsh-mobile-control__danger'); cloudflaredPurge.type = 'button'; cloudflaredPurge.textContent = t('purgeCloudflared')
  cloudflaredDetailsBody.append(cloudflaredDetailsText, cloudflaredStorage, cloudflaredOfficial, cloudflaredTerms, cloudflaredPurge); cloudflaredDetails.append(cloudflaredDetailsSummary, cloudflaredDetailsBody)
  cloudflaredSetup.append(cloudflaredSetupTitle, cloudflaredTunnel, cloudflaredTunnelSave, cloudflaredTunnelForget, cloudflaredComponentStatus, cloudflaredInstall, cloudflaredNote, cloudflaredDetails)
  providerSection.append(providerHeading, providerInfo, providerChoices)
  const providerSetupHeader = element('div', 'dsh-mobile-control__stage-header')
  const providerSetupHeading = element('h3', 'dsh-mobile-control__section-title'); providerSetupHeading.textContent = t('currentProvider')
  const providerSetupName = element('span', 'dsh-mobile-control__stage-value'); providerSetupName.textContent = 'cloudflared'
  const remoteStateBadge = element('span', 'dsh-mobile-control__state-badge'); remoteStateBadge.textContent = t('remoteStateOff')
  const providerSetupMeta = element('div', 'dsh-mobile-control__stage-meta'); providerSetupMeta.append(providerSetupName, remoteStateBadge)
  providerSetupHeader.append(providerSetupHeading, providerSetupMeta)
  const providerSetupBody = element('div', 'dsh-mobile-control__provider-setup-body')
  providerSetupBody.append(cloudflaredSetup, sakuraSetup)
  const remoteAccess = element('div', 'dsh-mobile-control__access'); remoteAccess.hidden = true
  const remoteAccessLabel = element('span', 'dsh-mobile-control__access-label'); remoteAccessLabel.textContent = t('remoteAddress')
  const remoteAccessLink = element('a', 'dsh-mobile-control__access-link'); remoteAccessLink.target = '_blank'; remoteAccessLink.rel = 'noreferrer'; remoteAccess.append(remoteAccessLabel, remoteAccessLink)
  const remoteQr = element('div', 'dsh-mobile-control__qr'); remoteQr.hidden = true
  const remoteStatus = element('p', 'dsh-mobile-control__status'); remoteStatus.textContent = t('loadingRemoteStatus'); remoteStatus.setAttribute('aria-live', 'polite')
  const remoteActions = element('div', 'dsh-mobile-control__actions')
  const remoteToggle = element('button', 'dsh-mobile-control__primary'); remoteToggle.type = 'button'; remoteToggle.textContent = t('enableRemote')
  const remoteReconnect = element('button', 'dsh-mobile-control__secondary'); remoteReconnect.type = 'button'; remoteReconnect.textContent = t('reconnect'); remoteReconnect.hidden = true
  const remotePair = element('button', 'dsh-mobile-control__secondary'); remotePair.type = 'button'; remotePair.textContent = t('generateRemoteQr'); remotePair.disabled = true
  const remoteCopyLink = element('button', 'dsh-mobile-control__secondary'); remoteCopyLink.type = 'button'; remoteCopyLink.textContent = t('copyRemoteLink'); remoteCopyLink.disabled = true
  const remotePairLink = element('p', 'dsh-mobile-control__status'); remotePairLink.hidden = true
  let activeRemotePairUrl = ''
  let activeRemotePairExpiresAt = 0
  remoteActions.append(remoteToggle, remoteReconnect, remotePair, remoteCopyLink)
  const remoteManageRow = element('div', 'dsh-mobile-control__manage-row')
  const remoteDevices = element('button', 'dsh-mobile-control__manage'); remoteDevices.type = 'button'; remoteDevices.textContent = t('manageRemoteDevices'); remoteDevices.disabled = true
  const remoteReset = element('button', 'dsh-mobile-control__manage'); remoteReset.type = 'button'; remoteReset.textContent = t('resetRemoteDevices')
  remoteManageRow.append(remoteDevices, remoteReset)
  const remoteDevicePanel = element('div', 'dsh-mobile-control__devices'); remoteDevicePanel.hidden = true
  const wsPathsSection = element('section', 'dsh-mobile-control__ws-paths')
  const wsPathsTitle = element('h3', 'dsh-mobile-control__section-title'); wsPathsTitle.textContent = t('wsPathsTitle')
  const wsPathsIntro = element('p', 'dsh-mobile-control__intro'); wsPathsIntro.textContent = t('wsPathsIntro')
  const wsPathsDetected = element('div', 'dsh-mobile-control__ws-paths-detected'); wsPathsDetected.hidden = true
  const wsPathsDetectedTitle = element('p', 'dsh-mobile-control__ws-paths-detected-title'); wsPathsDetectedTitle.textContent = t('wsPathsDetected')
  const wsPathsDetectedList = element('ul', 'dsh-mobile-control__ws-paths-list')
  wsPathsDetected.append(wsPathsDetectedTitle, wsPathsDetectedList)
  const wsPathsList = element('ul', 'dsh-mobile-control__ws-paths-list')
  const wsPathsAdvanced = element('details', 'dsh-mobile-control__ws-paths-advanced')
  const wsPathsAdvancedSummary = element('summary'); wsPathsAdvancedSummary.textContent = t('wsPathsAdvancedToggle')
  const wsPathsAdvancedHint = element('p', 'dsh-mobile-control__intro'); wsPathsAdvancedHint.textContent = t('wsPathsAdvancedHint')
  const wsPathsRow = element('div', 'dsh-mobile-control__ws-paths-row')
  const wsPathsInput = element('input', 'dsh-mobile-control__ws-paths-input'); wsPathsInput.type = 'text'; wsPathsInput.placeholder = t('wsPathsPlaceholder'); wsPathsInput.setAttribute('aria-label', t('wsPathsTitle'))
  const wsPathsAdd = element('button', 'dsh-mobile-control__primary'); wsPathsAdd.type = 'button'; wsPathsAdd.textContent = t('wsPathsAdd')
  const wsPathsStatus = element('p', 'dsh-mobile-control__status'); wsPathsStatus.hidden = true; wsPathsStatus.setAttribute('aria-live', 'polite')
  wsPathsRow.append(wsPathsInput, wsPathsAdd)
  wsPathsAdvanced.append(wsPathsAdvancedSummary, wsPathsAdvancedHint, wsPathsRow, wsPathsStatus)
  wsPathsSection.append(wsPathsTitle, wsPathsIntro, wsPathsDetected, wsPathsList, wsPathsAdvanced)
  let wsPathsCurrent: string[] = []
  let wsPathsBlocked: { readonly path: string; readonly attempts: number }[] = []
  let wsPathsLoaded = false
  const renderWsPaths = (paths: readonly string[]): void => {
    wsPathsCurrent = [...paths]
    wsPathsList.replaceChildren()
    if (paths.length === 0) {
      const empty = element('li', 'dsh-mobile-control__ws-paths-empty'); empty.textContent = t('wsPathsEmpty'); wsPathsList.append(empty)
    }
    for (const path of paths) {
      const item = element('li', 'dsh-mobile-control__ws-paths-item')
      const label = element('code'); label.textContent = path
      const remove = element('button', 'dsh-mobile-control__ws-paths-remove'); remove.type = 'button'; remove.textContent = t('wsPathsRemove'); remove.setAttribute('aria-label', `${t('wsPathsRemove')}: ${path}`)
      remove.addEventListener('click', () => { void saveWsPaths(wsPathsCurrent.filter(entry => entry !== path)) })
      item.append(label, remove)
      wsPathsList.append(item)
    }
  }
  const wsGroupOf = (path: string): string => {
    const slash = path.lastIndexOf('/')
    return slash > 0 ? path.slice(0, slash) : '/'
  }
  let wsPathsSeenAttempts = 0
  let wsDotAnnounced = 0
  const wsDotStatus = element('p', 'dsh-mobile-control__ws-sr-status')
  wsDotStatus.setAttribute('role', 'status'); wsDotStatus.setAttribute('aria-atomic', 'true')
  const wsBlockedTotal = (blocked: readonly { readonly attempts: number }[]): number =>
    blocked.reduce((sum, entry) => sum + entry.attempts, 0)
  const renderWsDot = (): void => {
    for (const stale of document.querySelectorAll('.dsh-mobile-control__ws-dot')) stale.remove()
    if (!wsDotStatus.isConnected) root.append(wsDotStatus)
    const pending = wsPathsBlocked.filter(entry => !wsPathsCurrent.includes(entry.path))
    const pendingCount = pending.length
    if (pendingCount === 0 || wsBlockedTotal(wsPathsBlocked) <= wsPathsSeenAttempts) {
      if (pendingCount === 0 && wsDotAnnounced !== 0) { wsDotAnnounced = 0; wsDotStatus.textContent = '' }
      return
    }
    if (wsDotAnnounced !== pendingCount) {
      wsDotAnnounced = pendingCount
      wsDotStatus.textContent = t('wsPathsAnnounce', { n: String(pendingCount) })
    }
    for (const trigger of document.querySelectorAll('.dsh-mobile-control__trigger, .dsh-mobile-control__diagnostic-entry')) {
      const dot = element('span', 'dsh-mobile-control__ws-dot'); dot.textContent = String(pendingCount); dot.title = t('wsPathsNewBlocked'); dot.setAttribute('aria-hidden', 'true')
      dot.addEventListener('click', event => { event.stopPropagation(); setOpen(true); selectView('diagnostics') })
      trigger.append(dot)
    }
  }
  const renderWsBlocked = (blocked: readonly { readonly path: string; readonly attempts: number }[]): void => {
    wsPathsDetectedList.replaceChildren()
    const pending = blocked.filter(entry => !wsPathsCurrent.includes(entry.path))
    wsPathsDetected.hidden = pending.length === 0
    const groups = new Map<string, { readonly path: string; readonly attempts: number }[]>()
    for (const entry of pending) {
      const group = wsGroupOf(entry.path)
      const list = groups.get(group)
      if (list) list.push(entry); else groups.set(group, [entry])
    }
    for (const [group, entries] of groups) {
      const groupItem = element('li', 'dsh-mobile-control__ws-paths-group')
      const groupHead = element('div', 'dsh-mobile-control__ws-paths-group-head')
      const groupLabel = element('code'); groupLabel.textContent = `${group}/*`
      const groupCount = element('span', 'dsh-mobile-control__ws-count')
      groupCount.textContent = t('wsPathsGroupMeta', { n: entries.length, m: entries.reduce((sum, entry) => sum + entry.attempts, 0) })
      groupHead.append(groupLabel, groupCount)
      if (entries.length > 1) {
        const allowAll = element('button', 'dsh-mobile-control__primary'); allowAll.type = 'button'; allowAll.textContent = t('wsPathsAllowAll')
        allowAll.addEventListener('click', () => { saveWsPaths([...wsPathsCurrent, ...entries.map(entry => entry.path)]) })
        groupHead.append(allowAll)
      }
      groupItem.append(groupHead)
      for (const entry of entries) {
        const item = element('div', 'dsh-mobile-control__ws-paths-item is-child')
        const label = element('code'); label.textContent = `${entry.path} ×${String(entry.attempts)}`
        const allow = element('button', 'dsh-mobile-control__primary'); allow.type = 'button'; allow.textContent = t('wsPathsAllow'); allow.setAttribute('aria-label', `${t('wsPathsAllow')}: ${entry.path}`)
        allow.addEventListener('click', () => { saveWsPaths([...wsPathsCurrent, entry.path]) })
        item.append(label, allow)
        groupItem.append(item)
      }
      wsPathsDetectedList.append(groupItem)
    }
    renderWsDot()
  }
  const loadWsPaths = (): void => {
    void controlRequestJson('/api/mobile-access/remote/websocket-paths').then(data => {
      wsPathsLoaded = true
      wsPathsStatus.hidden = true
      renderWsPaths(Array.isArray(data.paths) ? data.paths.filter((entry): entry is string => typeof entry === 'string') : [])
      void controlRequestJson('/api/mobile-access/remote/websocket-paths/blocked').then(blocked => {
        const entries = Array.isArray(blocked.blocked) ? blocked.blocked : []
        wsPathsBlocked = entries.filter((entry): entry is { path: string; attempts: number } =>
          typeof entry === 'object' && entry !== null
          && typeof (entry as { path?: unknown }).path === 'string'
          && typeof (entry as { attempts?: unknown }).attempts === 'number')
        renderWsBlocked(wsPathsBlocked)
      }, () => { /* approved list already rendered; detected list stays hidden */ })
    }, error => {
      wsPathsStatus.hidden = false
      wsPathsStatus.textContent = t('requestFailed', { error: String(error) })
    })
  }
  const saveWsPaths = (paths: readonly string[]): void => {
    wsPathsStatus.hidden = true
    void controlRequestJson('/api/mobile-access/remote/websocket-paths', { method: 'POST', body: JSON.stringify({ paths }) }).then(data => {
      wsPathsLoaded = true
      renderWsPaths(Array.isArray(data.paths) ? data.paths.filter((entry): entry is string => typeof entry === 'string') : [])
      renderWsBlocked(wsPathsBlocked)
    }, error => {
      wsPathsStatus.hidden = false
      wsPathsStatus.textContent = t('requestFailed', { error: String(error) })
    })
  }
  wsPathsAdd.addEventListener('click', () => {
    const value = wsPathsInput.value.trim()
    if (value === '') {
      wsPathsStatus.hidden = false
      wsPathsStatus.textContent = t('wsPathsInvalid')
      return
    }
    wsPathsInput.value = ''
    saveWsPaths([...wsPathsCurrent, value])
  })
  const remoteWorkspace = element('section', 'dsh-mobile-control__remote-workspace')
  remoteWorkspace.append(providerSetupHeader, remoteStatus, remoteAccess, providerSetupBody, remoteActions, remoteQr, remotePairLink, remoteManageRow, remoteDevicePanel)
  const diagnosticsView = element('div', 'dsh-mobile-control__view is-diagnostics'); diagnosticsView.hidden = true
  const diagnosticsIntro = element('p', 'dsh-mobile-control__intro'); diagnosticsIntro.textContent = t('diagnosticsIntro')
  const diagnosticsSummary = element('section', 'dsh-mobile-control__diagnostic-summary is-idle'); diagnosticsSummary.setAttribute('aria-live', 'polite')
  const diagnosticsSummaryMain = element('div', 'dsh-mobile-control__diagnostic-summary-main')
  const diagnosticsSummaryIcon = element('span', 'dsh-mobile-control__diagnostic-summary-icon'); diagnosticsSummaryIcon.setAttribute('aria-hidden', 'true')
  const diagnosticsSummaryBody = element('div', 'dsh-mobile-control__diagnostic-summary-body')
  const diagnosticsSummaryTitle = element('strong'); diagnosticsSummaryTitle.textContent = t('diagnosticsNotRun')
  const diagnosticsSummaryText = element('span'); diagnosticsSummaryText.textContent = t('diagnosticsStartHint')
  const diagnosticsSummaryMeta = element('span', 'dsh-mobile-control__diagnostic-summary-meta'); diagnosticsSummaryMeta.textContent = t('diagnosticsIdleMeta')
  diagnosticsSummaryBody.append(diagnosticsSummaryTitle, diagnosticsSummaryText)
  diagnosticsSummaryMain.append(diagnosticsSummaryIcon, diagnosticsSummaryBody)
  diagnosticsSummary.append(diagnosticsSummaryMain, diagnosticsSummaryMeta)
  const diagnosticsToolbar = element('div', 'dsh-mobile-control__diagnostic-toolbar')
  const diagnosticsRun = element('button', 'dsh-mobile-control__primary dsh-mobile-control__diagnostic-run'); diagnosticsRun.type = 'button'; diagnosticsRun.textContent = t('diagnosticsStart')
  const diagnosticsCopy = element('button', 'dsh-mobile-control__secondary dsh-mobile-control__diagnostic-copy'); diagnosticsCopy.type = 'button'; diagnosticsCopy.textContent = t('diagnosticsCopy'); diagnosticsCopy.disabled = true; diagnosticsCopy.hidden = true
  diagnosticsToolbar.append(diagnosticsRun, diagnosticsCopy)
  const diagnosticsFeedback = element('p', 'dsh-mobile-control__diagnostic-feedback'); diagnosticsFeedback.hidden = true; diagnosticsFeedback.setAttribute('role', 'status'); diagnosticsFeedback.setAttribute('aria-live', 'polite')
  const diagnosticsChecks = element('div', 'dsh-mobile-control__diagnostic-checks'); diagnosticsChecks.hidden = true
  const diagnosticsDetails = element('details', 'dsh-mobile-control__details dsh-mobile-control__diagnostic-details'); diagnosticsDetails.hidden = true
  const diagnosticsDetailsSummary = element('summary'); diagnosticsDetailsSummary.textContent = t('diagnosticsAdvanced')
  const diagnosticsReport = element('pre', 'dsh-mobile-control__diagnostic-report')
  diagnosticsDetails.append(diagnosticsDetailsSummary, diagnosticsReport)
  header.append(title, headerActions); actions.append(toggle, pair, linkPair)
  lanView.append(lanSetup, access, qrBox, status, extensionStatus, actions, manageRow, devicePanel, trustedNetworks)
  remoteView.append(remoteIntro, httpFrameWarning, providerSection, remoteWorkspace)
  diagnosticsView.append(diagnosticsIntro, diagnosticsSummary, diagnosticsToolbar, diagnosticsFeedback, diagnosticsChecks, wsPathsSection, diagnosticsDetails)
  panel.append(header, releaseNotice, updateCard, appDownload, extensionRecovery.section, switcher, lanView, remoteView, diagnosticsView); windowBox.append(backdrop, panel); root.append(windowBox); document.body.append(root)
  let running = false
  let origin = ''
  let lanConfigured = true
  let lanRestartRequired = false
  let lanSetupLoaded = false
  let remoteRunning = false
  let remoteReady = false
  let remoteProvider: MobileRemoteProvider = 'sakurafrp'
  let remoteReconnectBusy = false
  let remoteProviderBusy = false
  // A failed control action stores its message here so the repaint that loadRemote() runs in the
  // action's finally cannot replace it before the user reads it. The repaint that would have
  // erased it consumes the value instead, so it never lingers over a later state.
  let remoteFailureText: string | undefined
  let cloudflaredInstalled = false
  let cloudflaredDownloadSize = ''
  let cloudflaredTunnelConfigured = false
  let configuredCloudflaredHostname = ''
  let configuredCloudflaredPort = 3444
  // Once the user types in a field, polls must stop writing to it, or a stale
  // value the user is mid-edit would be silently replaced by the saved one.
  let cloudflaredHostnameDirty = false
  let cloudflaredPortDirty = false
  let remoteSnapshotEpoch = 0
  let latestRemoteState: Record<string, unknown> = {}
  let sakuraTokenSet = false
  let sakuraTunnelsLoaded = false
  let sakuraTunnelsBusy = false
  let sakuraDownloadSize = ''
  interface SakuraTunnel {
    readonly id: number
    readonly name: string
    readonly type: string
    readonly node: string
    readonly online: boolean
    readonly status: string
    readonly remote: string
    readonly localPort?: number
    readonly lockEdit?: boolean
  }
  const asSakuraTunnel = (entry: unknown): SakuraTunnel | undefined => {
    if (typeof entry !== 'object' || entry === null) return undefined
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.id !== 'number' || typeof candidate.name !== 'string' || typeof candidate.type !== 'string') return undefined
    return {
      id: candidate.id,
      name: candidate.name,
      type: candidate.type,
      node: typeof candidate.node === 'string' ? candidate.node : '',
      online: candidate.online === true,
      status: typeof candidate.status === 'string' ? candidate.status : '',
      remote: typeof candidate.remote === 'string' ? candidate.remote : '',
      ...(typeof candidate.localPort === 'number' ? { localPort: candidate.localPort } : {}),
      ...(candidate.lockEdit === true ? { lockEdit: true } : {}),
    }
  }
  let sakuraTunnels: readonly SakuraTunnel[] = []
  let configuredSakuraTunnelId: number | undefined
  let sakuraInstalled = false
  let providerInfoPinned = false
  let providerInfoHovered = false
  let previousAccessView: 'lan' | 'remote' = 'lan'
  let diagnosticsBusy = false
  let copiedDiagnosticReport = ''
  let pluginUpdateAvailable = false
  let pluginLatestVersion = ''
  let pluginReleaseNotes = ''
  let updateInFlight = false
  const renderRelease = (data: Record<string, unknown>): void => {
    const release = clientReleaseInfo(data)
    pluginUpdateAvailable = release.updateAvailable
    pluginLatestVersion = release.latestVersion ?? ''
    pluginReleaseNotes = release.releaseNotes ?? ''
    updatePlugin.hidden = !pluginUpdateAvailable || !diagnosticsView.hidden || !updateCard.hidden
    updatePlugin.textContent = t('updatePlugin')
    if (pluginLatestVersion !== '') updatePlugin.setAttribute('aria-label', t('updatePluginAria', { version: pluginLatestVersion }))
    if (release.androidVersion !== undefined) {
      appDownload.textContent = t('downloadAndroidVersion', { version: release.androidVersion })
      appDownload.setAttribute('aria-label', t('downloadAndroidVersionAria', { version: release.androidVersion }))
    }
    appDownload.href = release.androidDownloadUrl
  }
  const syncProviderInfo = (): void => {
    const open = providerInfoPinned || providerInfoHovered || providerInfo.contains(document.activeElement)
    providerInfoPopover.hidden = !open
    providerInfoButton.setAttribute('aria-expanded', String(open))
  }
  providerInfo.addEventListener('pointerenter', () => { providerInfoHovered = true; syncProviderInfo() })
  providerInfo.addEventListener('pointerleave', () => { providerInfoHovered = false; syncProviderInfo() })
  providerInfo.addEventListener('focusin', syncProviderInfo)
  providerInfo.addEventListener('focusout', () => { window.setTimeout(syncProviderInfo, 0) })
  providerInfoButton.addEventListener('click', () => { providerInfoPinned = !providerInfoPinned; syncProviderInfo() })
  providerInfoButton.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    providerInfoPinned = false
    providerInfoHovered = false
    providerInfoPopover.hidden = true
    providerInfoButton.setAttribute('aria-expanded', 'false')
  })
  const selectView = (view: 'lan' | 'remote' | 'diagnostics'): void => {
    if (!panel.hidden) void extensionRecovery.refresh()
    if (view !== 'diagnostics') previousAccessView = view
    lanView.hidden = view !== 'lan'
    remoteView.hidden = view !== 'remote'
    diagnosticsView.hidden = view !== 'diagnostics'
    lanTab.classList.toggle('is-active', view === 'lan')
    remoteTab.classList.toggle('is-active', view === 'remote')
    lanTab.setAttribute('aria-pressed', String(view === 'lan'))
    remoteTab.setAttribute('aria-pressed', String(view === 'remote'))
    diagnosticsEntry.setAttribute('aria-pressed', String(view === 'diagnostics'))
    diagnosticsEntry.textContent = view === 'diagnostics' ? t('back') : t('diagnostics')
    diagnosticsEntry.setAttribute('aria-label', view === 'diagnostics' ? t('backToMobile') : t('openDiagnostics'))
    if (view === 'diagnostics') {
      wsPathsSeenAttempts = wsBlockedTotal(wsPathsBlocked)
      renderWsDot()
      if (!wsPathsLoaded) loadWsPaths()
    }
    updatePlugin.hidden = view === 'diagnostics' || !pluginUpdateAvailable
    appDownload.hidden = view === 'diagnostics'
    switcher.hidden = view === 'diagnostics'
    title.textContent = view === 'lan' ? t('lanAccess') : view === 'remote' ? t('remoteAccess') : t('connectionDiagnostics')
  }
  lanTab.addEventListener('click', () => { selectView('lan') })
  remoteTab.addEventListener('click', () => { selectView('remote'); loadRemote() })
  let lastTriggerFocus: HTMLElement | undefined
  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    backdrop.hidden = !open
    // Modal semantics exist only while the window is open: a permanently
    // dialog-marked node would hijack DSH's own [role="dialog"] queries (its
    // onboarding flow matches that selector even for hidden elements).
    if (open) {
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-modal', 'true')
      void extensionRecovery.refresh()
      // Duck-typed on purpose: the Node test DOM has no HTMLElement global.
      const active = document.activeElement
      lastTriggerFocus = active !== null && typeof (active as { focus?: unknown }).focus === 'function'
        ? active as HTMLElement
        : undefined
      // The Node test DOM's FakeElement has no focus method; focus management is
      // a progressive enhancement over the plain open/close toggle.
      if (typeof panel.focus === 'function') panel.focus({ preventScroll: true })
    } else {
      if (typeof panel.removeAttribute === 'function') {
        panel.removeAttribute('role')
        panel.removeAttribute('aria-modal')
      }
      if (lastTriggerFocus !== undefined && lastTriggerFocus.isConnected && typeof lastTriggerFocus.focus === 'function') {
        lastTriggerFocus.focus({ preventScroll: true })
      }
      lastTriggerFocus = undefined
    }
    for (const trigger of document.querySelectorAll('.dsh-mobile-control__trigger')) trigger.setAttribute('aria-expanded', String(open))
  }
  const render = (data: Record<string, unknown>): void => {
    lanConfigured = data.configured !== false
    lanRestartRequired = data.restartRequired === true
    running = data.running === true
    origin = running && typeof data.origin === 'string' ? data.origin : ''
    lanSetup.hidden = lanConfigured && !lanRestartRequired
    lanSetupForm.hidden = lanRestartRequired
    lanSetupIntro.hidden = lanRestartRequired
    status.hidden = !lanConfigured || lanRestartRequired
    if (!lanConfigured && !lanSetupLoaded) loadLanSetup()
    if (lanRestartRequired) {
      const pendingOrigin = typeof data.pendingOrigin === 'string' ? data.pendingOrigin : ''
      lanSetupStatus.textContent = t('lanSetupRestart', { origin: pendingOrigin })
    } else if (!lanConfigured && lanSetupStatus.textContent === '') {
      lanSetupStatus.textContent = t('lanSetupRequired')
    }
    access.hidden = origin === ''
    accessLink.href = origin
    accessLink.textContent = origin
    accessLink.title = origin
    status.classList.toggle('is-running', running)
    status.textContent = !lanConfigured ? t('lanSetupRequired') : lanRestartRequired ? t('lanSetupRestart', { origin: typeof data.pendingOrigin === 'string' ? data.pendingOrigin : '' }) : running ? t('lanOn') : t('lanOff')
    const extensionData = data.extensions
    if (extensionData !== null && typeof extensionData === 'object') {
      const loaded = typeof (extensionData as { loaded?: unknown }).loaded === 'number' ? (extensionData as { loaded: number }).loaded : 0
      const failed = typeof (extensionData as { failed?: unknown }).failed === 'number' ? (extensionData as { failed: number }).failed : 0
      extensionStatus.hidden = false
      extensionStatus.textContent = failed === 0 ? t('extensionsLoaded', { loaded }) : t('extensionsFailed', { loaded, failed })
    } else extensionStatus.hidden = true
    if (!running) qrBox.hidden = true
    toggle.textContent = running ? t('disableLan') : t('enableLan')
    actions.hidden = !lanConfigured || lanRestartRequired
    manageRow.hidden = !lanConfigured || lanRestartRequired
    pair.disabled = !running
    linkPair.disabled = !running
    manageDevices.disabled = !running
    resetAll.disabled = !running
  }
  const renderLanSetup = (data: Record<string, unknown>): void => {
    if (data.restartRequired === true || data.configured === true) {
      render(data)
      return
    }
    const networks = Array.isArray(data.networks) ? data.networks.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : []
    lanSetupSelect.replaceChildren()
    const hasRecommended = networks.some(network => network.recommended === true)
    if (!hasRecommended && networks.length > 1) {
      const placeholder = element('option'); placeholder.value = ''; placeholder.textContent = t('lanSetupChooseNetwork'); placeholder.disabled = true; placeholder.selected = true
      lanSetupSelect.append(placeholder)
    }
    for (const network of networks) {
      if (typeof network.address !== 'string' || typeof network.name !== 'string') continue
      const option = element('option'); option.value = network.address
      option.textContent = `${network.name} · ${network.address}${network.recommended === true ? ` · ${t('lanSetupRecommended')}` : ''}`
      option.selected = network.recommended === true || (!hasRecommended && networks.length === 1)
      lanSetupSelect.append(option)
    }
    const available = networks.some(network => typeof network.address === 'string' && typeof network.name === 'string')
    lanSetupConfigure.disabled = lanSetupSelect.value === ''
    lanSetupStatus.textContent = available ? t('lanSetupRequired') : t('lanSetupNoNetworks')
    lanSetupNote.hidden = data.windowsFirewall !== true
  }
  lanSetupSelect.addEventListener('change', () => { lanSetupConfigure.disabled = lanSetupSelect.value === '' })
  const loadLanSetup = (): void => {
    lanSetupLoaded = true
    lanSetupRefresh.disabled = true
    void controlRequestJson('/api/mobile-access/lan/setup').then(renderLanSetup, () => {
      lanSetupStatus.textContent = t('lanSetupFailed')
    }).finally(() => { lanSetupRefresh.disabled = false })
  }
  lanSetupRefresh.addEventListener('click', () => { loadLanSetup() })
  lanSetupConfigure.addEventListener('click', () => {
    if (lanSetupSelect.value === '') return
    lanSetupConfigure.disabled = true
    lanSetupRefresh.disabled = true
    lanSetupConfigure.textContent = t('lanSetupConfiguring')
    lanSetupStatus.textContent = t('lanSetupConfiguring')
    void controlRequestJson('/api/mobile-access/lan/setup', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, address: lanSetupSelect.value, configureFirewall: true }),
    }, LONG_CONTROL_REQUEST_TIMEOUT_MS).then(renderLanSetup, () => {
      lanSetupStatus.textContent = t('lanSetupFailed')
    }).finally(() => {
      lanSetupConfigure.textContent = t('lanSetupConfigure')
      lanSetupRefresh.disabled = false
      lanSetupConfigure.disabled = lanRestartRequired || lanSetupSelect.options.length === 0
    })
  })
  const showQr = (svg: string, target: HTMLDivElement = qrBox): void => {
    target.replaceChildren()
    if (svg === '') { target.hidden = true; return }
    const image = element('img')
    image.alt = t('pairingQr')
    image.width = 176
    image.height = 176
    image.src = `data:image/svg+xml;base64,${btoa(svg)}`
    target.hidden = false
    target.append(image)
  }
  const openPairing = (target: 'key' | 'link'): void => {
    void controlRequestJson('/api/mobile-access/lan/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
      const value = target === 'key'
        ? (typeof data.appKey === 'string' ? data.appKey : '')
        : (typeof data.pairUrl === 'string' ? data.pairUrl : '')
      showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '')
      if (value === '') { status.textContent = t('keyGenerationFailed'); return }
      try {
        await navigator.clipboard.writeText(value)
        status.textContent = target === 'key'
          ? t('keyCopied')
          : t('linkCopied')
      } catch {
        status.textContent = t('copySecret', { kind: target === 'key' ? t('pairingKey') : t('pairingLink'), value })
        status.classList.add('is-key')
      }
    }, error => { status.textContent = t('requestFailed', { error: String(error) }) }).finally(() => {
      pair.disabled = !running
      linkPair.disabled = !running
    })
  }
  toggle.addEventListener('click', () => { toggle.disabled = true; void controlRequestJson('/api/mobile-access/lan/control', { method: 'POST', body: JSON.stringify({ running: !running }) }).then(render, error => { status.textContent = t('requestFailed', { error: String(error) }) }).finally(() => { toggle.disabled = false }) })
  const formatTime = (ms: unknown): string => typeof ms === 'number' ? new Date(ms).toLocaleString(localeTag) : ''
  const formatMegabytes = (bytes: number): string => new Intl.NumberFormat(localeTag, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)
  const renderDevices = (data: Record<string, unknown>): void => {
    const devices = Array.isArray(data.devices) ? data.devices as Record<string, unknown>[] : []
    devicePanel.replaceChildren()
    if (devices.length === 0) {
      const empty = element('p', 'dsh-mobile-control__device-empty'); empty.textContent = t('noDevices')
      devicePanel.append(empty)
      return
    }
    for (const device of devices) {
      const row = element('div', 'dsh-mobile-control__device')
      const label = element('span', 'dsh-mobile-control__device-label')
      label.textContent = typeof device.label === 'string' ? device.label : t('device')
      const meta = element('span', 'dsh-mobile-control__device-meta'); meta.textContent = t('expires', { time: formatTime(device.expiresAt) })
      const revoke = element('button', 'dsh-mobile-control__device-revoke'); revoke.type = 'button'; revoke.textContent = t('revoke')
      const id = typeof device.id === 'string' ? device.id : ''
      revoke.addEventListener('click', () => {
        void controlRequestJson('/api/mobile-access/lan/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
          .then(loadDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
      })
      row.append(label, meta, revoke)
      devicePanel.append(row)
    }
  }
  const loadDevices = (): void => {
    void controlRequestJson('/api/mobile-access/lan/devices').then(renderDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  }
  manageDevices.addEventListener('click', () => {
    const show = devicePanel.hidden
    devicePanel.hidden = !show
    if (show) loadDevices()
  })
  resetAll.addEventListener('click', () => {
    if (!window.confirm(t('confirmResetDevices'))) return
    void controlRequestJson('/api/mobile-access/lan/devices/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(loadDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  })
  const renderRemote = (data: Record<string, unknown>): void => {
    latestRemoteState = data
    remoteRunning = data.running === true
    remoteProvider = parseMobileRemoteProvider(data.provider)
    const cloudflared = remoteProvider === 'cloudflared'
    const sakurafrp = remoteProvider === 'sakurafrp'
    cloudflaredChoice.classList.toggle('is-selected', cloudflared)
    sakuraChoice.classList.toggle('is-selected', sakurafrp)
    cloudflaredChoice.setAttribute('aria-checked', String(cloudflared))
    sakuraChoice.setAttribute('aria-checked', String(sakurafrp))
    // One tab stop for the group: only the checked card is reachable with Tab.
    cloudflaredChoice.tabIndex = cloudflared ? 0 : -1
    sakuraChoice.tabIndex = sakurafrp ? 0 : -1
    providerSetupName.textContent = cloudflared ? 'cloudflared' : 'SakuraFrp'
    cloudflaredChoice.disabled = remoteProviderBusy
    sakuraChoice.disabled = remoteProviderBusy
    cloudflaredSetup.hidden = !cloudflared
    sakuraSetup.hidden = !sakurafrp
    remoteReset.textContent = t('resetRemoteDevices')
    const providers = data.providers !== null && typeof data.providers === 'object' ? data.providers as Record<string, unknown> : {}
    const cloudflaredProvider = providers.cloudflared !== null && typeof providers.cloudflared === 'object' ? providers.cloudflared as Record<string, unknown> : {}
    const cloudflaredComponent = cloudflaredProvider.component !== null && typeof cloudflaredProvider.component === 'object'
      ? cloudflaredProvider.component as Record<string, unknown>
      : {}
    cloudflaredInstalled = cloudflaredComponent.installed === true
    const cloudflaredSupported = cloudflaredComponent.supported !== false
    const cloudflaredComponentError = typeof cloudflaredComponent.errorCode === 'string' ? cloudflaredComponent.errorCode : ''
    const cloudflaredVersion = typeof cloudflaredComponent.version === 'string' ? cloudflaredComponent.version : ''
    const cloudflaredDownloadBytes = typeof cloudflaredComponent.downloadBytes === 'number' ? cloudflaredComponent.downloadBytes : 0
    if (cloudflaredDownloadBytes > 0) cloudflaredDownloadSize = formatMegabytes(cloudflaredDownloadBytes)
    const cloudflaredStoragePath = typeof cloudflaredComponent.storagePath === 'string'
      ? cloudflaredComponent.storagePath
      : `DSH Mobile ${t('pluginPrivateDirectory')}`
    cloudflaredStorage.textContent = cloudflaredStoragePath
    cloudflaredStorage.title = cloudflaredStoragePath
    cloudflaredChoiceBadge.textContent = cloudflaredInstalled ? t('ready') : t('cloudflaredBadge')
    cloudflaredInstall.hidden = cloudflaredInstalled || !cloudflaredSupported
    cloudflaredInstall.textContent = cloudflaredDownloadBytes > 0
      ? t('installWithSize', { size: formatMegabytes(cloudflaredDownloadBytes) })
      : t('installOfficial')
    cloudflaredInstall.disabled = remoteProviderBusy
    cloudflaredPurge.hidden = !cloudflaredInstalled
    cloudflaredComponentStatus.textContent = !cloudflaredSupported
      ? t('cloudflaredUnsupported')
      : !cloudflaredInstalled
        // A component that exists but failed verification must not be reported as
        // absent: that sends the user to reinstall something already installed.
        ? (cloudflaredComponentError === 'cloudflared_component_invalid' ? t('cloudflaredInvalid') : t('cloudflaredNotInstalled'))
        : t('cloudflaredReady', { version: cloudflaredVersion })
    const cloudflaredTunnelConfiguration = cloudflaredProvider.configuration !== null
      && typeof cloudflaredProvider.configuration === 'object'
      ? cloudflaredProvider.configuration as Record<string, unknown>
      : {}
    cloudflaredTunnelConfigured = cloudflaredTunnelConfiguration.configured === true
    configuredCloudflaredHostname = typeof cloudflaredTunnelConfiguration.hostname === 'string' ? cloudflaredTunnelConfiguration.hostname : ''
    configuredCloudflaredPort = typeof cloudflaredTunnelConfiguration.port === 'number' ? cloudflaredTunnelConfiguration.port : 3444
    const cloudflaredTunnelError = typeof cloudflaredTunnelConfiguration.errorCode === 'string' ? cloudflaredTunnelConfiguration.errorCode : ''
    // Untouched fields always mirror the saved configuration, so a field can never
    // keep showing a value that is no longer in effect.
    if (!cloudflaredHostnameDirty) cloudflaredHostname.value = configuredCloudflaredHostname
    if (!cloudflaredPortDirty) cloudflaredPort.value = String(configuredCloudflaredPort)
    cloudflaredToken.placeholder = cloudflaredTunnelConfigured ? t('cloudflaredTunnelTokenSaved') : t('cloudflaredTunnelTokenPlaceholder')
    // The hint must describe the port Cloudflare will actually be pointed at, which
    // is the one in the field, not the last saved value.
    const cloudflaredFieldPort = String(cloudflaredPort.value ?? '').trim()
    cloudflaredTunnelHint.textContent = t('cloudflaredTunnelHint', {
      port: cloudflaredFieldPort === '' ? String(configuredCloudflaredPort) : cloudflaredFieldPort,
    })
    cloudflaredTunnelStatus.textContent = cloudflaredTunnelError !== ''
      ? t('cloudflaredTunnelInvalid')
      : cloudflaredTunnelConfigured
        ? t('cloudflaredTunnelConfigured', { hostname: configuredCloudflaredHostname, port: String(configuredCloudflaredPort) })
        : t('cloudflaredTunnelMissing')
    cloudflaredTunnelSave.disabled = remoteProviderBusy || !cloudflaredInstalled
    cloudflaredTunnelForget.hidden = !cloudflaredTunnelConfigured
    const sakuraProvider = providers.sakurafrp !== null && typeof providers.sakurafrp === 'object' ? providers.sakurafrp as Record<string, unknown> : {}
    const sakuraConfiguration = sakuraProvider.configuration !== null && typeof sakuraProvider.configuration === 'object'
      ? sakuraProvider.configuration as Record<string, unknown>
      : {}
    const sakuraComponent = sakuraProvider.component !== null && typeof sakuraProvider.component === 'object'
      ? sakuraProvider.component as Record<string, unknown>
      : {}
    sakuraInstalled = sakuraComponent.installed === true
    const sakuraSupported = sakuraComponent.supported !== false
    const sakuraComponentError = typeof sakuraComponent.errorCode === 'string' ? sakuraComponent.errorCode : ''
    const sakuraVersion = typeof sakuraComponent.version === 'string' ? sakuraComponent.version : ''
    const sakuraDownloadBytes = typeof sakuraComponent.downloadBytes === 'number' ? sakuraComponent.downloadBytes : 0
    if (sakuraDownloadBytes > 0) sakuraDownloadSize = formatMegabytes(sakuraDownloadBytes)
    const sakuraStoragePath = typeof sakuraComponent.storagePath === 'string' ? sakuraComponent.storagePath : `DSH Mobile ${t('pluginPrivateDirectory')}`
    sakuraStorage.textContent = sakuraStoragePath
    sakuraStorage.title = sakuraStoragePath
    sakuraChoiceBadge.textContent = sakuraConfiguration.configured === true ? t('ready') : t('mainlandPreferred')
    sakuraTokenSet = sakuraConfiguration.tokenSet === true
    sakuraToken.placeholder = sakuraTokenSet ? t('sakuraTokenSaved') : t('tokenPlaceholder')
    const sakuraTunnelError = typeof sakuraConfiguration.errorCode === 'string' ? sakuraConfiguration.errorCode : ''
    const configuredSakuraTunnelName = typeof sakuraConfiguration.tunnelName === 'string' ? sakuraConfiguration.tunnelName : ''
    if (typeof sakuraConfiguration.tunnelId === 'number') configuredSakuraTunnelId = sakuraConfiguration.tunnelId
    sakuraTunnelStatus.textContent = sakuraTunnelError !== ''
      ? (t(REMOTE_ERROR_MESSAGE_KEYS[sakuraTunnelError] ?? 'sakuraTunnelEmpty'))
      : sakuraConfiguration.configured === true
        ? (configuredSakuraTunnelName !== ''
          ? t('sakuraTunnelConfigured', { name: configuredSakuraTunnelName, id: configuredSakuraTunnelId ?? 0 })
          : t('sakuraTunnelConfigured', { name: '', id: configuredSakuraTunnelId ?? 0 }))
        : t('sakuraTunnelEmpty')
    sakuraTunnelRefresh.disabled = remoteProviderBusy || !sakuraTokenSet
    sakuraTunnelSelect.disabled = remoteProviderBusy || !sakuraTokenSet
    sakuraConfigure.disabled = remoteProviderBusy || !sakuraInstalled || !sakuraTokenSet || sakuraTunnelSelect.value === ''
    sakuraInstall.hidden = sakuraInstalled || !sakuraSupported
    sakuraInstall.textContent = sakuraDownloadBytes > 0
      ? t('installWithSize', { size: formatMegabytes(sakuraDownloadBytes) })
      : t('installFrpc')
    sakuraInstall.disabled = remoteProviderBusy
    sakuraPurge.hidden = !sakuraInstalled && !sakuraTokenSet
    sakuraComponentStatus.textContent = !sakuraSupported
      ? t('cloudflaredUnsupported')
      : !sakuraInstalled
        ? (sakuraComponentError === 'sakurafrp_component_invalid' ? t('sakuraFrpcInvalid') : t('sakuraFrpcMissing'))
        : t('sakuraFrpcReady', { version: sakuraVersion })
    sakuraTokenSave.disabled = remoteProviderBusy
    if (sakuraTokenSet && !sakuraTunnelsLoaded && !sakuraTunnelsBusy) loadSakuraTunnels()
    const state = typeof data.state === 'string' ? data.state : 'error'
    const errorCode = typeof data.errorCode === 'string' ? data.errorCode : ''
    const remoteOrigin = typeof data.origin === 'string' ? data.origin : ''
    remoteReady = remoteRunning && state === 'ready' && remoteOrigin !== ''
    remoteStateBadge.classList.toggle('is-ready', remoteReady)
    remoteStateBadge.classList.toggle('is-busy', state === 'starting' || state === 'connecting')
    remoteStateBadge.classList.toggle('is-attention', state === 'error' || state === 'unavailable')
    remoteStateBadge.textContent = remoteReady
      ? t('ready')
      : state === 'starting' || state === 'connecting'
        ? t('remoteStateConnecting')
        : state === 'error' || state === 'unavailable'
          ? t('remoteStateAttention')
          : t('remoteStateOff')
    remoteAccess.hidden = !remoteReady
    remoteAccessLink.href = remoteOrigin
    remoteAccessLink.textContent = remoteOrigin
    remoteAccessLink.title = remoteOrigin
    remoteStatus.classList.toggle('is-running', remoteReady)
    // An in-flight action owns the status line: the 1.5 s poll repaint must not
    // overwrite its message with the slower-changing provider state, which made
    // every "Save and connect" click look like it did nothing.
    if (!remoteProviderBusy) {
      const labels: Record<string, string> = {
        off: t('remoteOff'),
        unavailable: cloudflared ? t('remoteUnavailableCloudflared') : t('remoteUnavailableSakura'),
        starting: cloudflared ? t('remoteStartingCloudflared') : t('remoteStartingSakura'),
        connecting: cloudflared ? t('remoteConnectingCloudflared') : t('remoteConnectingSakura'),
        ready: t('remoteReady'),
        error: t('remoteError'),
      }
      const errorLabels: Record<string, string> = translatedRemoteErrors()
      remoteStatus.textContent = state === 'error' ? (errorLabels[errorCode] ?? labels.error!) : (labels[state] ?? labels.error!)
      // Keep a just-failed action's message for this one repaint, then release it.
      if (remoteFailureText !== undefined) {
        remoteStatus.textContent = remoteFailureText
        remoteFailureText = undefined
      }
    }
    remoteToggle.textContent = remoteRunning ? t('disableRemote') : t('enableRemote')
    const providerPrepared = cloudflared ? cloudflaredInstalled
      : sakuraInstalled && sakuraTokenSet && sakuraConfiguration.configured === true
    remoteToggle.disabled = remoteProviderBusy || (!providerPrepared && !remoteRunning)
    remoteReconnect.hidden = (state !== 'error' && state !== 'unavailable') || !providerPrepared
    remoteActions.hidden = !providerPrepared && !remoteRunning
    remotePair.disabled = !remoteReady || remoteProviderBusy
    remoteCopyLink.disabled = !remoteReady || remoteProviderBusy
    remoteDevices.disabled = !remoteReady || remoteProviderBusy
    remoteReset.disabled = false
    if (!remoteReady) {
      remoteQr.hidden = true
      remotePairLink.hidden = true
      activeRemotePairUrl = ''
      activeRemotePairExpiresAt = 0
    }
  }
  let remoteLoadInFlight = false
  const loadRemote = (): void => {
    if (remoteLoadInFlight) return
    const epoch = remoteSnapshotEpoch
    remoteLoadInFlight = true
    void controlRequestJson('/api/mobile-access/remote/control')
      .then(data => { if (epoch === remoteSnapshotEpoch) renderRemote(data) }, error => {
        if (epoch === remoteSnapshotEpoch) remoteStatus.textContent = t('requestFailed', { error: String(error) })
      })
      .finally(() => { remoteLoadInFlight = false })
  }
  const chooseRemoteProvider = (provider: MobileRemoteProvider): void => {
    if (remoteProviderBusy || provider === remoteProvider) return
    if (remoteRunning && !window.confirm(t('switchProviderConfirm'))) return
    remoteProviderBusy = true
    cloudflaredChoice.disabled = true
    sakuraChoice.disabled = true
    remoteStatus.textContent = provider === 'cloudflared' ? t('switchingCloudflared') : t('switchingSakura')
    void controlRequestJson('/api/mobile-access/remote/provider', { method: 'POST', body: JSON.stringify({ provider }) })
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  }
  cloudflaredChoice.addEventListener('click', () => { chooseRemoteProvider('cloudflared') })
  sakuraChoice.addEventListener('click', () => { chooseRemoteProvider('sakurafrp') })
  cloudflaredInstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const accepted = window.confirm(t('installConfirmCloudflared', { size: cloudflaredDownloadSize }))
    if (!accepted) return
    remoteProviderBusy = true
    cloudflaredInstall.disabled = true
    cloudflaredInstall.textContent = t('downloading')
    remoteStatus.textContent = t('installingCloudflared')
    void controlRequestJson('/api/mobile-access/remote/cloudflared/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'installFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  cloudflaredPurge.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm(t('purgeCloudflaredConfirm'))) return
    remoteProviderBusy = true
    cloudflaredPurge.disabled = true
    remoteStatus.textContent = t('purgingCloudflared')
    void controlRequestJson('/api/mobile-access/remote/cloudflared/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteFailureText = t('purgeFailed', { error: String(error) }); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; cloudflaredPurge.disabled = false; loadRemote() })
  })
  cloudflaredHostname.addEventListener('input', () => { cloudflaredHostnameDirty = true })
  cloudflaredPort.addEventListener('input', () => { cloudflaredPortDirty = true })
  cloudflaredTunnelSave.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const hostname = String(cloudflaredHostname.value ?? '').trim()
    const portValue = String(cloudflaredPort.value ?? '').trim()
    const port = Number(portValue)
    const token = String(cloudflaredToken.value ?? '')
    // The provider re-validates everything; these checks only keep an obviously
    // incomplete form from costing a round trip.
    if (hostname === '') { remoteStatus.textContent = t('cloudflaredTunnelHostnameInvalid'); return }
    if (portValue === '' || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      remoteStatus.textContent = t('cloudflaredTunnelPortInvalid')
      return
    }
    // The LAN gateway owns 3443 for as long as DSH runs, so this is not a
    // transient conflict worth a round trip.
    if (port === 3443) { remoteStatus.textContent = t('cloudflaredTunnelPortReserved'); return }
    if (token === '' && !cloudflaredTunnelConfigured) { remoteStatus.textContent = t('cloudflaredTunnelConfigMissing'); return }
    if (token !== '' && (token.length < 32 || !/^[A-Za-z0-9_=+/-]+$/u.test(token))) {
      remoteStatus.textContent = t('cloudflaredTunnelTokenInvalid')
      return
    }
    remoteProviderBusy = true
    cloudflaredTunnelSave.disabled = true
    cloudflaredTunnelSave.textContent = t('saving')
    remoteStatus.textContent = t('cloudflaredTunnelSaving')
    // Saving now also establishes the tunnel, so this request needs the long budget.
    void controlRequestJson('/api/mobile-access/remote/cloudflared/tunnel', {
      method: 'POST',
      body: JSON.stringify({ mode: 'named', hostname, port, token }),
    }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(data => {
        // The token is write-only: never keep a copy in the DOM after saving.
        cloudflaredToken.value = ''
        // The saved values are now authoritative, so let the next poll restore them.
        cloudflaredHostnameDirty = false
        cloudflaredPortDirty = false
        remoteFailureText = ''
        renderRemote(data)
      }, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => {
        remoteProviderBusy = false
        cloudflaredTunnelSave.disabled = false
        cloudflaredTunnelSave.textContent = t('cloudflaredTunnelSave')
        loadRemote()
      })
  })
  cloudflaredTunnelForget.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm(t('cloudflaredTunnelForgetConfirm'))) return
    remoteProviderBusy = true
    cloudflaredTunnelForget.disabled = true
    remoteStatus.textContent = t('cloudflaredTunnelForgetting')
    void controlRequestJson('/api/mobile-access/remote/cloudflared/tunnel/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(data => {
        cloudflaredToken.value = ''
        cloudflaredHostname.value = ''
        cloudflaredPort.value = '3444'
        cloudflaredHostnameDirty = false
        cloudflaredPortDirty = false
        remoteFailureText = ''
        renderRemote(data)
      }, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; cloudflaredTunnelForget.disabled = false; loadRemote() })
  })
  const renderSakuraTunnelOptions = (): void => {
    sakuraTunnelSelect.replaceChildren()
    // Only TCP tunnels are supported: the gateway terminates HTTPS itself and
    // forwards the public connection to the local DSH HTTP port.
    const usable = sakuraTunnels.filter(tunnel => tunnel.type === 'tcp')
    const banned = sakuraTunnels.filter(tunnel => tunnel.type !== 'tcp' && tunnel.status === 'banned')
    if (usable.length === 0) {
      const empty = element('option'); empty.value = ''; empty.textContent = t('sakuraTunnelEmpty'); empty.disabled = true; empty.selected = true
      sakuraTunnelSelect.append(empty)
      if (banned.length > 0) sakuraTunnelHint.textContent = t('sakuraTunnelBanned')
      else sakuraTunnelHint.textContent = t('sakuraTunnelEmpty')
      return
    }
    const placeholder = element('option'); placeholder.value = ''; placeholder.textContent = t('sakuraTunnelSelect'); placeholder.disabled = true; placeholder.selected = configuredSakuraTunnelId === undefined
    sakuraTunnelSelect.append(placeholder)
    for (const tunnel of usable) {
      const option = element('option'); option.value = String(tunnel.id)
      const meta = [tunnel.node, tunnel.online ? t('sakuraTunnelOnline') : t('sakuraTunnelOffline'), tunnel.remote].filter(Boolean).join(' · ')
      option.textContent = `${tunnel.name} · ${meta}`
      option.selected = configuredSakuraTunnelId !== undefined && configuredSakuraTunnelId === tunnel.id
      if (tunnel.lockEdit === true) option.disabled = true
      sakuraTunnelSelect.append(option)
    }
    sakuraTunnelHint.textContent = t('sakuraTunnelHint')
  }
  const sakuraTokenSaveClick = (): void => {
    if (remoteProviderBusy) return
    const token = sakuraToken.value.trim()
    // An empty field keeps the saved token, but the first save must carry one.
    if (token === '' && !sakuraTokenSet) {
      remoteStatus.textContent = t('sakuraTokenMissing')
      sakuraToken.focus()
      return
    }
    remoteProviderBusy = true
    remoteSnapshotEpoch += 1
    sakuraTokenSave.disabled = true
    sakuraTokenSave.setAttribute('aria-busy', 'true')
    sakuraTokenSave.textContent = t('saving')
    void controlRequestJson('/api/mobile-access/remote/sakurafrp/token', { method: 'POST', body: JSON.stringify({ token }) })
      .then(data => {
        sakuraToken.value = ''
        remoteStatus.textContent = t('sakuraTokenSavedNow')
        renderRemote(data)
      }, error => { remoteFailureText = t('configureFailed', { error: String(error) }); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; sakuraTokenSave.setAttribute('aria-busy', 'false'); sakuraTokenSave.textContent = t('saveToken'); loadRemote() })
  }
  sakuraTokenSave.addEventListener('click', sakuraTokenSaveClick)
  const loadSakuraTunnels = (): void => {
    if (sakuraTunnelsBusy || !sakuraTokenSet) return
    sakuraTunnelsBusy = true
    sakuraTunnelRefresh.disabled = true
    sakuraTunnelSelect.disabled = true
    sakuraTunnelStatus.textContent = t('loadingRemoteStatus')
    void controlRequestJson('/api/mobile-access/remote/sakurafrp/tunnels').then(data => {
      sakuraTunnelsLoaded = true
      const entries = Array.isArray(data.tunnels) ? data.tunnels : []
      sakuraTunnels = entries.map(asSakuraTunnel).filter((entry): entry is SakuraTunnel => entry !== undefined)
      renderSakuraTunnelOptions()
    }, error => {
      sakuraTunnelStatus.textContent = t('requestFailed', { error: String(error) })
    }).finally(() => { sakuraTunnelsBusy = false; renderRemote(latestRemoteState) })
  }
  sakuraTunnelRefresh.addEventListener('click', loadSakuraTunnels)
  sakuraTunnelSelect.addEventListener('change', () => { sakuraConfigure.disabled = remoteProviderBusy || !sakuraInstalled || !sakuraTokenSet || sakuraTunnelSelect.value === '' })
  sakuraConfigure.addEventListener('click', () => {
    if (remoteProviderBusy || !sakuraInstalled || !sakuraTokenSet) return
    const tunnelId = Number(sakuraTunnelSelect.value)
    if (!Number.isSafeInteger(tunnelId)) {
      remoteStatus.textContent = t('sakuraTunnelEmpty')
      return
    }
    remoteProviderBusy = true
    sakuraConfigure.disabled = true
    sakuraConfigure.setAttribute('aria-busy', 'true')
    sakuraConfigure.textContent = t('saving')
    // Saving now also establishes the channel (component check, tunnel API,
    // gateway start), so this request needs the long budget.
    void controlRequestJson('/api/mobile-access/remote/sakurafrp/configure', { method: 'POST', body: JSON.stringify({ tunnelId }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(data => {
        remoteStatus.textContent = t('sakuraConfigured')
        renderRemote(data)
      }, error => { remoteFailureText = remoteFailureTextFor(error, 'configureFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => {
        remoteProviderBusy = false
        sakuraConfigure.setAttribute('aria-busy', 'false')
        sakuraConfigure.textContent = t('sakuraConfigureSave')
        loadRemote()
      })
  })
  sakuraInstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const accepted = window.confirm(t('sakuraInstallConfirm', { size: sakuraDownloadSize }))
    if (!accepted) return
    remoteProviderBusy = true
    sakuraInstall.disabled = true
    sakuraInstall.textContent = t('downloading')
    remoteStatus.textContent = t('sakuraInstallingFrpc')
    void controlRequestJson('/api/mobile-access/remote/sakurafrp/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'installFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  sakuraPurge.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm(t('sakuraPurgeConfirm'))) return
    remoteProviderBusy = true
    sakuraPurge.disabled = true
    remoteStatus.textContent = t('sakuraPurgingFrpc')
    void controlRequestJson('/api/mobile-access/remote/sakurafrp/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(data => {
        sakuraTunnels = []
        sakuraTunnelsLoaded = false
        sakuraTokenSet = false
        configuredSakuraTunnelId = undefined
        renderRemote(data)
      }, error => { remoteFailureText = t('purgeFailed', { error: String(error) }); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; sakuraPurge.disabled = false; loadRemote() })
  })
  remoteToggle.addEventListener('click', () => {
    remoteToggle.disabled = true
    void controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: !remoteRunning }) })
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(loadRemote)
  })
  const reconnectRemote = (): void => {
    if (remoteReconnectBusy) return
    remoteReconnectBusy = true
    remoteReconnect.disabled = true
    remoteStatus.textContent = remoteProvider === 'cloudflared' ? t('reconnectingCloudflared') : t('reconnectingSakura')
    void controlRequestJson('/api/mobile-access/remote/reconnect', { method: 'POST', body: '{}' })
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => {
        remoteReconnectBusy = false
        remoteReconnect.disabled = false
      })
  }
  remoteReconnect.addEventListener('click', reconnectRemote)
  const copyRemotePairUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(activeRemotePairUrl)
      remoteStatus.textContent = t('linkCopied')
    } catch {
      remoteStatus.textContent = t('remoteQrReady')
    }
  }
  const openRemotePairing = (): Promise<void> => controlRequestJson('/api/mobile-access/remote/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
    const pairUrl = typeof data.pairUrl === 'string' ? data.pairUrl : ''
    const expiresAt = typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : 0
    showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '', remoteQr)
    if (pairUrl === '') { remoteStatus.textContent = t('keyGenerationFailed'); return }
    // QR and copy actions share the same one-time pairing window. Re-copying
    // cannot invalidate a QR that the phone may already be scanning.
    activeRemotePairUrl = pairUrl
    activeRemotePairExpiresAt = expiresAt
    remotePairLink.textContent = pairUrl
    remotePairLink.classList.add('is-key')
    remotePairLink.hidden = false
    await copyRemotePairUrl()
  })
  remotePair.addEventListener('click', () => {
    remotePair.disabled = true
    void openRemotePairing()
      .catch(error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remotePair.disabled = !remoteReady })
  })
  remoteCopyLink.addEventListener('click', () => {
    remoteCopyLink.disabled = true
    const operation = activeRemotePairUrl !== '' && activeRemotePairExpiresAt > Date.now()
      ? copyRemotePairUrl()
      : openRemotePairing()
    void operation
      .catch(error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteCopyLink.disabled = !remoteReady })
  })
  const renderRemoteDevices = (data: Record<string, unknown>): void => {
    const devices = Array.isArray(data.devices) ? data.devices as Record<string, unknown>[] : []
    remoteDevicePanel.replaceChildren()
    if (devices.length === 0) {
      const empty = element('p', 'dsh-mobile-control__device-empty'); empty.textContent = t('noRemoteDevices'); remoteDevicePanel.append(empty); return
    }
    for (const device of devices) {
      const row = element('div', 'dsh-mobile-control__device')
      const label = element('span', 'dsh-mobile-control__device-label'); label.textContent = typeof device.label === 'string' ? device.label : t('device')
      const meta = element('span', 'dsh-mobile-control__device-meta'); meta.textContent = t('expires', { time: formatTime(device.expiresAt) })
      const revoke = element('button', 'dsh-mobile-control__device-revoke'); revoke.type = 'button'; revoke.textContent = t('revoke')
      const id = typeof device.id === 'string' ? device.id : ''
      revoke.addEventListener('click', () => {
        void controlRequestJson('/api/mobile-access/remote/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
          .then(loadRemoteDevices, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      })
      row.append(label, meta, revoke); remoteDevicePanel.append(row)
    }
  }
  const loadRemoteDevices = (): void => {
    void controlRequestJson('/api/mobile-access/remote/devices').then(renderRemoteDevices, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
  }
  remoteDevices.addEventListener('click', () => {
    const show = remoteDevicePanel.hidden
    remoteDevicePanel.hidden = !show
    if (show) loadRemoteDevices()
  })
  remoteReset.addEventListener('click', () => {
    const prompt = remoteProvider === 'cloudflared'
      ? t('resetCloudflaredConfirm') : t('resetSakuraConfirm')
    if (!window.confirm(prompt)) return
    void controlRequestJson('/api/mobile-access/remote/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
  })
  const renderDiagnostics = (data: Record<string, unknown>): void => {
    const entries = [...diagnosticEntriesForRender(data)]
    const overall = diagnosticOverallForChecks(data.overall, entries.map(entry => entry.status))
    diagnosticsSummary.className = `dsh-mobile-control__diagnostic-summary is-${overall}`
    diagnosticsSummaryTitle.textContent = overall === 'ok' ? t('diagnosticsComplete') : overall === 'attention' ? t('diagnosticsAttention') : t('diagnosticsProblem')
    diagnosticsSummaryText.textContent = locale === 'zh' && data.overall === overall && typeof data.summary === 'string' ? data.summary : t('diagnosticsCompleteFallback')
    diagnosticsChecks.replaceChildren()
    const statusLabels: Record<string, string> = { ok: t('diagnosticStatusOk'), warning: t('diagnosticStatusWarning'), error: t('diagnosticStatusError'), info: t('diagnosticStatusInfo') }
    const diagnosticLabelKeys: Record<string, string> = {
      versions: 'diagnosticLabelVersions', network: 'diagnosticLabelNetwork', lan: 'diagnosticLabelLan',
      firewall: 'diagnosticLabelFirewall', remote: 'diagnosticLabelRemote', 'phone-network': 'diagnosticLabelPhone',
    }
    const statusOf = (entry: Record<string, unknown>): 'ok' | 'warning' | 'error' | 'info' => normalizeDiagnosticStatus(entry.status)
    const localizedEntryCopy = (entry: Record<string, unknown>): { readonly detail: string; readonly action: string } => {
      const serverCopy = diagnosticServerCopy(entry)
      const reason = typeof entry.reason === 'string' ? entry.reason : ''
      const facts = entry.facts !== null && typeof entry.facts === 'object' ? entry.facts as Record<string, unknown> : {}
      const copyReason = facts.viaProxy === true && (reason === 'remote-ready' || reason === 'remote-rate-limited')
        ? `${reason}-via-proxy` : reason
      const catalog = DIAGNOSTIC_REASON_MESSAGES[locale] as Readonly<Record<string, readonly [string, string]>>
      const templates = catalog[copyReason]
      if (templates === undefined) return serverCopy
      // Diagnostics read as sentences, so an internal provider id or a raw controller
      // code belongs in the report, not in the prose: it renders as
      // "Remote access through origin is currently off." or "reported gateway_start_failed".
      const providerNames: Record<string, string> = {
        cloudflared: 'cloudflared', sakurafrp: 'SakuraFrp',
      }
      const providerId = typeof facts.provider === 'string' ? facts.provider : ''
      const controllerKey = typeof facts.controllerCode === 'string' ? REMOTE_ERROR_MESSAGE_KEYS[facts.controllerCode] : undefined
      const values: Record<string, string> = {
        provider: providerNames[providerId] ?? '',
        latencyMs: typeof facts.latencyMs === 'number' && Number.isFinite(facts.latencyMs) ? new Intl.NumberFormat(localeTag).format(facts.latencyMs) : '',
        interfaceName: typeof facts.interfaceName === 'string' ? facts.interfaceName : '',
        endpointSuffix: typeof facts.endpointSuffix === 'string' ? facts.endpointSuffix : '',
        // A translated sentence when the code is known, otherwise nothing rather than
        // an identifier no user can act on.
        controllerCode: controllerKey === undefined ? '' : t(controllerKey),
      }
      const interpolate = (template: string): string => template.replace(/\{(\w+)\}/gu, (_match, key: string) => values[key] ?? '')
      let detail = interpolate(templates[0])
      let action = interpolate(templates[1])
      if (reason === 'versions-current') {
        const versions = data.versions !== null && typeof data.versions === 'object' ? data.versions as Record<string, unknown> : {}
        if ([versions.plugin, versions.dsh, versions.minimumAndroidApp].every(value => typeof value === 'string')) {
          detail += ` plugin ${String(versions.plugin)}, DSH ${String(versions.dsh)}, Android ${String(versions.minimumAndroidApp)}.`
        }
      }
      if (reason === 'remote-controller-error') action = diagnosticControllerAction(facts.controllerCode, locale, action)
      return { detail, action }
    }
    const appendGroup = (label: string, groupEntries: Record<string, unknown>[]): void => {
      if (groupEntries.length === 0) return
      const group = element('section', 'dsh-mobile-control__diagnostic-group')
      const groupHeader = element('header', 'dsh-mobile-control__diagnostic-group-header')
      const groupTitle = element('h3'); groupTitle.textContent = label
      const groupCount = element('span'); groupCount.textContent = t('diagnosticItems', { count: groupEntries.length })
      const list = element('div', 'dsh-mobile-control__diagnostic-list'); list.setAttribute('role', 'list')
      groupHeader.append(groupTitle, groupCount)
      for (const entry of groupEntries) {
        const state = statusOf(entry)
        const row = element('section', `dsh-mobile-control__diagnostic-check is-${state}`); row.setAttribute('role', 'listitem')
        const marker = element('span', 'dsh-mobile-control__diagnostic-marker'); marker.setAttribute('aria-hidden', 'true')
        const rowBody = element('div', 'dsh-mobile-control__diagnostic-check-body')
        const rowHeader = element('div', 'dsh-mobile-control__diagnostic-check-header')
        const labelKey = typeof entry.id === 'string' ? diagnosticLabelKeys[entry.id] : undefined
        const rowTitle = element('strong'); rowTitle.textContent = locale !== 'zh' && labelKey !== undefined ? t(labelKey) : typeof entry.label === 'string' ? entry.label : t('diagnosticCheck')
        const badge = element('span', 'dsh-mobile-control__diagnostic-badge'); badge.textContent = statusLabels[state]!
        const localizedCopy = localizedEntryCopy(entry)
        const detail = element('p'); detail.textContent = localizedCopy.detail
        rowHeader.append(rowTitle, badge); rowBody.append(rowHeader, detail)
        if (localizedCopy.action !== '') {
          const action = element('p', 'dsh-mobile-control__diagnostic-action')
          const actionLabel = element('span'); actionLabel.textContent = t('diagnosticAction')
          action.append(actionLabel, document.createTextNode(localizedCopy.action)); rowBody.append(action)
        }
        row.append(marker, rowBody); list.append(row)
      }
      group.append(groupHeader, list); diagnosticsChecks.append(group)
    }
    const issues = entries.filter(entry => statusOf(entry) === 'error' || statusOf(entry) === 'warning')
    const otherChecks = entries.filter(entry => statusOf(entry) !== 'error' && statusOf(entry) !== 'warning')
    appendGroup(t('diagnosticNeedsAction'), issues)
    appendGroup(issues.length === 0 ? t('diagnosticDetails') : t('diagnosticOther'), otherChecks)
    diagnosticsSummaryMeta.textContent = issues.length === 0
      ? t('diagnosticNoBlockers', { count: entries.length })
      : t('diagnosticNeedsCount', { count: entries.length, issues: issues.length })
    diagnosticsChecks.hidden = entries.length === 0
    const reportCopy = LOCALIZED_DIAGNOSTIC_COPY[locale]
    const generatedAt = typeof data.generatedAt === 'number' ? new Date(data.generatedAt).toLocaleString(localeTag) : new Date().toLocaleString(localeTag)
    const lines = entries.map(entry => {
      const state = statusOf(entry)
      const labelKey = typeof entry.id === 'string' ? diagnosticLabelKeys[entry.id] : undefined
      const label = labelKey === undefined && typeof entry.label === 'string' ? entry.label : labelKey === undefined ? t('diagnosticCheck') : t(labelKey)
      const localizedCopy = localizedEntryCopy(entry)
      return `[${statusLabels[state]!}] ${label}: ${localizedCopy.detail}${localizedCopy.action === '' ? '' : ` ${localizedCopy.action}`}`
    })
    copiedDiagnosticReport = [reportCopy.reportTitle, `${reportCopy.generated}: ${generatedAt}`, ...lines].join('\n')
    diagnosticsReport.textContent = copiedDiagnosticReport
    diagnosticsDetails.hidden = copiedDiagnosticReport === ''
    diagnosticsCopy.disabled = copiedDiagnosticReport === ''
    diagnosticsCopy.hidden = copiedDiagnosticReport === ''
    diagnosticsToolbar.classList.toggle('has-report', copiedDiagnosticReport !== '')
  }
  const showDiagnosticsFailure = (error: unknown): void => {
    diagnosticsSummary.className = 'dsh-mobile-control__diagnostic-summary is-error'
    diagnosticsSummaryTitle.textContent = t('diagnosticsIncomplete')
    diagnosticsSummaryText.textContent = t('diagnosticsReadFailed', { error: String(error) })
    diagnosticsSummaryMeta.textContent = t('diagnosticsUnavailable')
    diagnosticsChecks.replaceChildren()
    diagnosticsChecks.hidden = true
    copiedDiagnosticReport = ''
    diagnosticsReport.textContent = ''
    diagnosticsDetails.hidden = true
    diagnosticsCopy.disabled = true
    diagnosticsCopy.hidden = true
    diagnosticsToolbar.classList.remove('has-report')
  }
  const loadDiagnostics = (): void => {
    if (diagnosticsBusy) return
    diagnosticsBusy = true
    diagnosticsRun.disabled = true
    diagnosticsRun.setAttribute('aria-busy', 'true')
    diagnosticsRun.textContent = t('diagnosticsChecking')
    diagnosticsSummary.className = 'dsh-mobile-control__diagnostic-summary is-running'
    diagnosticsSummaryTitle.textContent = t('diagnosticsCheckingTitle')
    diagnosticsSummaryText.textContent = t('diagnosticsCheckingText')
    diagnosticsSummaryMeta.textContent = t('diagnosticsRunningMeta')
    diagnosticsFeedback.hidden = true
    diagnosticsChecks.classList.add('is-refreshing')
    diagnosticsChecks.setAttribute('aria-busy', 'true')
    void controlRequestJson('/api/mobile-access/diagnostics').then(
      data => { renderDiagnosticPayloadSafely(data, renderDiagnostics, showDiagnosticsFailure) },
      showDiagnosticsFailure,
    ).finally(() => {
      diagnosticsBusy = false
      diagnosticsRun.disabled = false
      diagnosticsRun.setAttribute('aria-busy', 'false')
      diagnosticsRun.textContent = t('diagnosticsRetry')
      diagnosticsChecks.classList.remove('is-refreshing')
      diagnosticsChecks.setAttribute('aria-busy', 'false')
    })
  }
  diagnosticsEntry.addEventListener('click', () => {
    if (!diagnosticsView.hidden) { selectView(previousAccessView); return }
    selectView('diagnostics'); loadDiagnostics()
  })
  diagnosticsRun.addEventListener('click', loadDiagnostics)
  diagnosticsRun.addEventListener('click', () => { void extensionRecovery.refresh() })
  const closeUpdateCard = (): void => {
    updateCard.hidden = true
    if (pluginUpdateAvailable && pluginLatestVersion !== '') updatePlugin.hidden = !diagnosticsView.hidden
  }
  const runPluginUpdate = (): void => {
    if (!pluginUpdateAvailable || pluginLatestVersion === '' || updateInFlight) return
    updateInFlight = true
    updateNow.disabled = true
    updateLater.disabled = true
    updateCardTitle.textContent = t('updatingPlugin')
    releaseNotice.hidden = true
    releaseNotice.classList.remove('is-error')
    void controlRequestJson('/api/mobile-access/release/update', { method: 'POST', body: '{}' }, LONG_CONTROL_REQUEST_TIMEOUT_MS).then(data => {
      const installedVersion = releaseVersion(data.installedVersion) ?? pluginLatestVersion
      pluginUpdateAvailable = false
      updateCard.hidden = true
      updatePlugin.hidden = true
      releaseNotice.textContent = t('pluginUpdatedRestart', { version: installedVersion })
      releaseNotice.hidden = false
    }, error => {
      updateCard.hidden = true
      updatePlugin.hidden = false
      releaseNotice.textContent = t('pluginUpdateFailed', { error: String(error) })
      releaseNotice.classList.add('is-error')
      releaseNotice.hidden = false
    }).finally(() => {
      updateInFlight = false
      updateNow.disabled = false
      updateLater.disabled = false
    })
  }
  updatePlugin.addEventListener('click', () => {
    if (!pluginUpdateAvailable || pluginLatestVersion === '' || updateInFlight) return
    updatePlugin.hidden = true
    updateCardTitle.textContent = t('updateTo', { version: pluginLatestVersion })
    updateCardNotes.textContent = pluginReleaseNotes === '' ? t('updateNotesEmpty') : pluginReleaseNotes
    updateCardNotes.hidden = pluginReleaseNotes === ''
    updateCard.hidden = false
  })
  updateNow.addEventListener('click', runPluginUpdate)
  updateLater.addEventListener('click', closeUpdateCard)
  diagnosticsCopy.addEventListener('click', () => {
    if (copiedDiagnosticReport === '') return
    void navigator.clipboard.writeText(copiedDiagnosticReport).then(() => {
      diagnosticsFeedback.textContent = t('diagnosticsCopied')
      diagnosticsFeedback.hidden = false
    }, () => {
      diagnosticsDetails.open = true
      diagnosticsFeedback.textContent = t('diagnosticsCopyManual')
      diagnosticsFeedback.hidden = false
    })
  })
  pair.addEventListener('click', () => { pair.disabled = true; openPairing('key') })
  linkPair.addEventListener('click', () => { linkPair.disabled = true; openPairing('link') })
  close.addEventListener('click', () => { setOpen(false) })
  backdrop.addEventListener('click', () => { if (!panel.hidden) setOpen(false) })
  const onEscapeKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || panel.hidden || event.defaultPrevented) return
    // The settings window is modal: claim Escape so DSH layers beneath it stay closed.
    event.preventDefault()
    event.stopImmediatePropagation()
    setOpen(false)
  }
  window.addEventListener('keydown', onEscapeKey, true)
  const dismiss = (event: PointerEvent): void => {
    if (panel.hidden || !(event.target instanceof Node)) return
    if (!providerInfo.contains(event.target)) {
      providerInfoPinned = false
      providerInfoHovered = false
      syncProviderInfo()
    }
    if (!panel.contains(event.target) && !document.querySelector('.dsh-mobile-control__trigger')?.contains(event.target)) setOpen(false)
  }
  document.addEventListener('pointerdown', dismiss)
  void controlRequestJson('/api/mobile-access/release').then(renderRelease, () => {})
  void controlRequestJson('/api/mobile-access/lan/control').then(render, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  loadRemote()
  const remotePoll = window.setInterval(() => { if (!panel.hidden && !remoteView.hidden) loadRemote() }, 1_500)
  const pollWsBlocked = (): void => {
    void controlRequestJson('/api/mobile-access/remote/websocket-paths/blocked').then(blocked => {
      const raw = Array.isArray(blocked.blocked) ? blocked.blocked : []
      wsPathsBlocked = raw.filter((entry): entry is { path: string; attempts: number } =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as { path?: unknown }).path === 'string'
        && typeof (entry as { attempts?: unknown }).attempts === 'number')
      renderWsDot()
      if (!diagnosticsView.hidden) renderWsBlocked(wsPathsBlocked)
    }, () => { /* gateway unreachable; dot keeps its last state */ })
  }
  const wsBlockedPoll = window.setInterval(() => { pollWsBlocked(); if (!panel.hidden) void extensionRecovery.refresh() }, 20_000)
  return { remove: () => { lifecycle.abort(); extensionRecovery.dispose(); window.clearInterval(remotePoll); window.clearInterval(wsBlockedPoll); document.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', onEscapeKey, true); root.remove() }, toggle: () => { setOpen(panel.hidden !== false) }, isOpen: () => !panel.hidden }
}

function mobileRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(path, location.href)
  if (target.origin !== location.origin) throw new TypeError('mobile extension requests must stay on the DSH origin')
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('dsh_ma_csrf='))?.slice(12)
    if (csrf !== undefined) headers.set('x-dsh-mobile-csrf', csrf)
  }
  return fetch(target, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
}

export interface CombinedClientSignal {
  readonly signal: AbortSignal
  readonly cleanup: () => void
}

/** Combine extension and caller abort lifetimes and expose deterministic listener cleanup. */
export function combineClientSignalLifetime(first: AbortSignal, second: AbortSignal): CombinedClientSignal {
  if (first.aborted || second.aborted) {
    const aborted = new AbortController()
    aborted.abort(first.aborted ? first.reason : second.reason)
    return { signal: aborted.signal, cleanup: () => undefined }
  }
  const controller = new AbortController()
  const cleanup = (): void => {
    first.removeEventListener('abort', abortFirst)
    second.removeEventListener('abort', abortSecond)
  }
  const abortFirst = (): void => { cleanup(); controller.abort(first.reason) }
  const abortSecond = (): void => { cleanup(); controller.abort(second.reason) }
  first.addEventListener('abort', abortFirst, { once: true })
  second.addEventListener('abort', abortSecond, { once: true })
  return { signal: controller.signal, cleanup }
}

/** Combine extension and caller abort lifetimes on WebViews without AbortSignal.any. */
export function combineClientSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  return combineClientSignalLifetime(first, second).signal
}

/** Keep a combined request lifetime until a streamed response is consumed or cancelled. */
export function bindClientResponseLifetime(response: Response, cleanup: () => void): Response {
  if (response.body === null) {
    cleanup()
    return response
  }
  const reader = response.body.getReader()
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    cleanup()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          release()
          controller.close()
        } else controller.enqueue(result.value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally { release() }
    },
  })
  try {
    const retained = new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText })
    Object.defineProperties(retained, {
      redirected: { configurable: true, value: response.redirected },
      type: { configurable: true, value: response.type },
      url: { configurable: true, value: response.url },
    })
    return retained
  } catch (error) {
    void reader.cancel(error)
    release()
    throw error
  }
}

/** Dispose an old UI when its replacement Host generation cannot be activated. */
export function failClosedExtensionGenerationReplacement(
  hasActive: boolean,
  activeGeneration: string | undefined,
  replacementGeneration: string | undefined,
  dispose: () => void,
): boolean {
  if (!hasActive || activeGeneration === replacementGeneration) return false
  dispose()
  return true
}

/** Resolve one SDK route and prove its normalized path remains in the current extension namespace. */
export function extensionRouteUrl(id: string, path: string, baseUrl: string): URL {
  const rawPathname = path.split(/[?#]/u, 1)[0] ?? ''
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id) || !path.startsWith('/') || path.startsWith('//')
    || rawPathname.includes('\\') || rawPathname.includes('\0') || /%(?:2f|5c)/iu.test(rawPathname)) {
    throw new TypeError('extension routes must be relative')
  }
  const origin = new URL(baseUrl).origin
  const prefix = `/mobile-access/extensions/${id}/routes`
  let target: URL
  try { target = new URL(`${prefix}${path}`, origin) } catch { throw new TypeError('extension routes must be relative') }
  let decodedPathname: string
  try { decodedPathname = decodeURIComponent(target.pathname) } catch { throw new TypeError('extension routes must be relative') }
  if (target.origin !== origin || target.hash !== '' || decodedPathname.includes('\\')
    || decodedPathname !== prefix && !decodedPathname.startsWith(`${prefix}/`)) {
    throw new TypeError('extension routes must be relative')
  }
  const relative = decodedPathname.slice(prefix.length)
  if (relative.split('/').some(part => part === '.' || part === '..')) throw new TypeError('extension routes must be relative')
  return target
}

/** Resolve one generation-pinned static asset URL in the current extension namespace. */
export function extensionAssetUrl(id: string, generation: string | undefined, path: string, baseUrl: string): URL {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id) || generation !== undefined && !/^[a-f\d]{64}$/u.test(generation)) {
    throw new TypeError('extension asset path is invalid')
  }
  const normalized = path.replaceAll('\\', '/')
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new TypeError('extension asset path is invalid')
  }
  const target = new URL(`/mobile-access/extensions/${id}/assets/${normalized.split('/').map(encodeURIComponent).join('/')}`, new URL(baseUrl).origin)
  if (generation !== undefined) target.searchParams.set('generation', generation)
  return target
}

/** Add the immutable Host generation selected for one activated mobile UI. */
export function extensionGenerationHeaders(generation: string | undefined, headers?: HeadersInit): Headers {
  const result = new Headers(headers)
  if (generation !== undefined) result.set('x-dsh-mobile-extension-generation', generation)
  return result
}

/** Build the JSON request used by a mobile extension to invoke a Host action. */
export function extensionActionRequestInit(generation: string | undefined, input: unknown, signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: extensionGenerationHeaders(generation, { 'content-type': 'application/json' }),
    body: JSON.stringify(input ?? {}),
    signal,
  }
}

export function registerUniqueDisposable<T extends { readonly dispose: () => void }>(
  entries: Map<string, T>,
  claimedIds: Set<string>,
  id: string,
  mount: () => T,
): () => void {
  if (claimedIds.has(id)) throw new Error(`duplicate lifecycle id: ${id}`)
  claimedIds.add(id)
  let mounted: T
  try { mounted = mount() } catch (error) { claimedIds.delete(id); throw error }
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    mounted.dispose()
  }
  const entry = { ...mounted, dispose } as T
  entries.set(id, entry)
  return () => {
    if (entries.get(id) === entry) { entries.delete(id); claimedIds.delete(id) }
    dispose()
  }
}

/** Dispose resources omitted by a successfully fetched authoritative manifest. */
export function reconcileRemovedExtensions(currentIds: Iterable<string>, seen: ReadonlySet<string>, dispose: (id: string) => void): void {
  for (const id of new Set(currentIds)) if (!seen.has(id)) dispose(id)
}

/** Reconcile managed resources against one validated authoritative id set. */
export function publishAuthoritativeExtensionIds(
  authoritativeIds: Set<string>,
  seen: ReadonlySet<string>,
  managedIdSources: readonly Iterable<string>[],
  dispose: (id: string) => void,
): void {
  const current = new Set(authoritativeIds)
  for (const source of managedIdSources) for (const id of source) current.add(id)
  reconcileRemovedExtensions(current, seen, dispose)
  authoritativeIds.clear()
  for (const id of seen) authoritativeIds.add(id)
}

interface MobileExtensionManifestEntry {
  readonly id: string
  readonly generation?: string
  readonly scriptUrl?: string
  readonly styleUrl?: string
  readonly assetsUrl?: string
}
interface MobileExtensionManifest {
  readonly extensions: readonly MobileExtensionManifestEntry[]
  readonly legacy: { readonly scriptRevision: string; readonly styleRevision: string }
}

function validManifestResourceUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('://')
    && !value.split('/').some(part => part === '..' || part === '.')
}

/** Validate the manifest before treating it as authoritative state. */
export function parseMobileExtensionManifest(payload: unknown): MobileExtensionManifest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = payload as { protocol?: unknown; extensions?: unknown; legacy?: unknown }
  if (candidate.protocol !== 1 || !Array.isArray(candidate.extensions) || typeof candidate.legacy !== 'object' || candidate.legacy === null) return undefined
  const legacy = candidate.legacy as { scriptRevision?: unknown; styleRevision?: unknown }
  if (typeof legacy.scriptRevision !== 'string' || typeof legacy.styleRevision !== 'string') return undefined
  const ids = new Set<string>()
  const extensions: MobileExtensionManifestEntry[] = []
  for (const value of candidate.extensions) {
    if (typeof value !== 'object' || value === null) return undefined
    const entry = value as { id?: unknown; generation?: unknown; scriptUrl?: unknown; styleUrl?: unknown; assetsUrl?: unknown }
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.id) || ids.has(entry.id)) return undefined
    if (entry.generation !== undefined && (typeof entry.generation !== 'string' || !/^[a-f\d]{64}$/u.test(entry.generation))) return undefined
    if (entry.scriptUrl !== undefined && !validManifestResourceUrl(entry.scriptUrl)) return undefined
    if (entry.styleUrl !== undefined && !validManifestResourceUrl(entry.styleUrl)) return undefined
    if (entry.assetsUrl !== undefined && !validManifestResourceUrl(entry.assetsUrl)) return undefined
    ids.add(entry.id)
    extensions.push({
      id: entry.id,
      ...(entry.generation === undefined ? {} : { generation: entry.generation }),
      ...(entry.scriptUrl === undefined ? {} : { scriptUrl: entry.scriptUrl }),
      ...(entry.styleUrl === undefined ? {} : { styleUrl: entry.styleUrl }),
      ...(entry.assetsUrl === undefined ? {} : { assetsUrl: entry.assetsUrl }),
    })
  }
  return { extensions, legacy: { scriptRevision: legacy.scriptRevision, styleRevision: legacy.styleRevision } }
}

/** A missing manifest is authoritative before optional legacy resources finish refreshing. */
export async function handleMissingExtensionManifest(
  clearManifestResources: () => void,
  refreshLegacyResources: () => Promise<readonly boolean[]>,
  signal: AbortSignal,
): Promise<boolean> {
  clearManifestResources()
  const results = await refreshLegacyResources()
  return !signal.aborted && results.every(Boolean)
}

interface LifecycleSchedulerRuntime {
  readonly document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>
}

export interface LifecycleRefreshController {
  (): void
  refresh(): void
}

function refreshAborted(signal: AbortSignal): boolean { return signal.aborted }

/** Run one coalesced refresh cycle, slowing down when the page is hidden. */
export function startLifecycleRefreshScheduler(
  refresh: (signal: AbortSignal) => void | Promise<void>,
  options: { readonly visibleIntervalMs?: number; readonly hiddenIntervalMs?: number; readonly cycleTimeoutMs?: number } = {},
  runtime: LifecycleSchedulerRuntime = { document, window },
): LifecycleRefreshController {
  const visibleIntervalMs = options.visibleIntervalMs ?? 45_000
  const hiddenIntervalMs = options.hiddenIntervalMs ?? 300_000
  const cycleTimeoutMs = options.cycleTimeoutMs ?? 30_000
  let timer: number | undefined
  let cycleTimer: number | undefined
  let running = false
  let queued = false
  let disposed = false
  let controller: AbortController | undefined
  const clearTimer = (): void => {
    if (timer === undefined) return
    runtime.window.clearTimeout(timer)
    timer = undefined
  }
  const clearCycleTimer = (): void => {
    if (cycleTimer === undefined) return
    runtime.window.clearTimeout(cycleTimer)
    cycleTimer = undefined
  }
  const schedule = (): void => {
    if (disposed) return
    clearTimer()
    const delay = runtime.document.visibilityState === 'hidden' ? hiddenIntervalMs : visibleIntervalMs
    timer = runtime.window.setTimeout(run, delay)
  }
  const run = (): void => {
    if (disposed) return
    clearTimer()
    if (running) { queued = true; return }
    running = true
    const current = new AbortController()
    controller = current
    const refreshPromise = Promise.resolve().then(() => refresh(current.signal))
    const timeoutPromise = new Promise<void>(resolve => {
      cycleTimer = runtime.window.setTimeout(() => {
        cycleTimer = undefined
        current.abort(new DOMException('mobile extension refresh timed out', 'TimeoutError'))
        resolve()
      }, cycleTimeoutMs)
    })
    void Promise.race([refreshPromise, timeoutPromise]).catch(() => { /* Keep the last good resources during reconnects. */ }).finally(() => {
      clearCycleTimer()
      if (controller === current) controller = undefined
      running = false
      if (disposed) return
      if (queued) { queued = false; run() } else schedule()
    })
    void refreshPromise.catch(() => { /* A timed-out refresh may reject after the scheduler has moved on. */ })
  }
  const onVisibilityChange = (): void => {
    if (runtime.document.visibilityState === 'hidden') schedule()
    else run()
  }
  runtime.document.addEventListener('visibilitychange', onVisibilityChange)
  runtime.window.addEventListener('focus', run)
  runtime.window.addEventListener('online', run)
  run()
  const stop = (): void => {
    disposed = true
    queued = false
    controller?.abort()
    controller = undefined
    clearCycleTimer()
    clearTimer()
    runtime.document.removeEventListener('visibilitychange', onVisibilityChange)
    runtime.window.removeEventListener('focus', run)
    runtime.window.removeEventListener('online', run)
  }
  return Object.assign(stop, { refresh: run })
}

interface ExtensionEventRuntime {
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>
  readonly create: (url: string) => Pick<EventSource, 'close' | 'onopen' | 'onerror' | 'addEventListener'>
}

/** Maintain one authenticated same-origin extension event stream with bounded reconnect backoff. */
export function startExtensionChangeStream(
  changed: () => void,
  runtime: ExtensionEventRuntime = {
    window,
    create: url => new EventSource(url, { withCredentials: true }),
  },
  onTaskEvent?: (payload: unknown) => void,
  onDeviceRevoked?: () => void,
): () => void {
  let source: ReturnType<ExtensionEventRuntime['create']> | undefined
  let timer: number | undefined
  let disposed = false
  let retryMs = 1_000
  const clearTimer = (): void => {
    if (timer === undefined) return
    runtime.window.clearTimeout(timer)
    timer = undefined
  }
  const connect = (): void => {
    if (disposed || source !== undefined) return
    clearTimer()
    const next = runtime.create('/mobile-access/extensions/events')
    source = next
    next.onopen = () => { retryMs = 1_000 }
    next.addEventListener('extensions-changed', changed)
    if (onTaskEvent !== undefined) {
      next.addEventListener('task-notify', (message: Event) => {
        const data = (message as MessageEvent).data
        onTaskEvent(data)
      })
    }
    if (onDeviceRevoked !== undefined) {
      next.addEventListener('device-revoked', (message: Event) => {
        const data = (message as MessageEvent).data
        if (isDeviceRevokedPayload(data)) onDeviceRevoked()
      })
    }
    next.onerror = () => {
      if (source !== next) return
      next.close()
      source = undefined
      if (disposed) return
      const delay = retryMs
      retryMs = Math.min(30_000, retryMs * 2)
      timer = runtime.window.setTimeout(connect, delay)
    }
  }
  const reconnectNow = (): void => {
    if (disposed) return
    source?.close()
    source = undefined
    retryMs = 1_000
    connect()
  }
  runtime.window.addEventListener('online', reconnectNow)
  connect()
  return () => {
    disposed = true
    clearTimer()
    source?.close()
    source = undefined
    runtime.window.removeEventListener('online', reconnectNow)
  }
}

export interface ActivationWork<T> {
  readonly result: Promise<T>
  readonly cancel: () => void
  readonly commit?: (value: T) => void
  readonly dispose: (value: T) => void
}

interface PendingActivation<T> {
  readonly key: object
  readonly generation: number
  readonly controller: AbortController
  readonly cancel: () => void
  readonly completion: Promise<boolean>
}

/** Keep at most one activation in flight per id and commit only its latest generation. */
export class PerIdActivationLifecycle<T> {
  private readonly active = new Map<string, { readonly value: T; readonly dispose: () => void }>()
  private readonly pending = new Map<string, PendingActivation<T>>()
  private readonly generations = new Map<string, number>()
  private disposed = false

  hasActive(id: string): boolean { return this.active.has(id) }
  getActive(id: string): T | undefined { return this.active.get(id)?.value }
  pendingCount(): number { return this.pending.size }

  async activate(
    id: string,
    key: object,
    cycleSignal: AbortSignal | undefined,
    create: (controller: AbortController, generation: number) => ActivationWork<T>,
  ): Promise<boolean> {
    if (this.disposed || cycleSignal?.aborted === true) return false
    const existing = this.pending.get(id)
    if (existing !== undefined) {
      if (existing.key === key && !existing.controller.signal.aborted) return this.waitFor(existing, cycleSignal)
      existing.cancel()
    }
    const generation = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, generation)
    const controller = new AbortController()
    let work: ActivationWork<T>
    try { work = create(controller, generation) } catch {
      controller.abort(new DOMException('mobile extension activation failed to start', 'AbortError'))
      return false
    }
    let cancelled = false
    let pending = {} as PendingActivation<T>
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      if (this.pending.get(id) === pending) this.pending.delete(id)
      if (this.generations.get(id) === generation) this.generations.set(id, generation + 1)
      controller.abort(new DOMException('mobile extension activation cancelled', 'AbortError'))
      work.cancel()
    }
    const completion = Promise.resolve(work.result).then(value => {
      const current = this.pending.get(id)
      const canCommit = !this.disposed && current === pending && current.generation === this.generations.get(id)
        && !controller.signal.aborted
      if (!canCommit) {
        try { work.dispose(value) } catch { /* A stale extension disposer must not break lifecycle cleanup. */ }
        return false
      }
      try { work.commit?.(value) } catch {
        try { work.dispose(value) } catch { /* Keep the previous active extension intact. */ }
        return false
      }
      const previous = this.active.get(id)
      let valueDisposed = false
      const dispose = (): void => {
        if (valueDisposed) return
        valueDisposed = true
        controller.abort(new DOMException('mobile extension deactivated', 'AbortError'))
        try { work.dispose(value) } catch { /* Disposers are isolated per extension. */ }
      }
      this.active.set(id, { value, dispose })
      previous?.dispose()
      return true
    }, () => {
      cancel()
      return false
    }).finally(() => {
      if (this.pending.get(id) === pending) this.pending.delete(id)
    })
    Object.assign(pending, { key, generation, controller, cancel, completion })
    this.pending.set(id, pending)
    return this.waitFor(pending, cycleSignal)
  }

  remove(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.active.get(id)?.dispose()
    this.active.delete(id)
    this.pending.get(id)?.cancel()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const current of this.active.values()) current.dispose()
    this.active.clear()
    for (const current of this.pending.values()) current.cancel()
  }

  private waitFor(pending: PendingActivation<T>, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal === undefined) return pending.completion
    if (signal.aborted) { pending.cancel(); return Promise.resolve(false) }
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => { pending.cancel(); finish(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void pending.completion.then(finish)
    })
  }
}

function installCustomAssets(): () => void {
  const legacyStyle = element('style'); legacyStyle.dataset.plugin = 'dsh-mobile-custom'; document.head.append(legacyStyle)
  const legacyCssState = { etag: '', modified: '' }
  const previous = window.dshMobile
  let legacyMount: MobileExtensionMount | undefined = queuedLegacyMount
  let legacySource = ''
  let legacyRoot: HTMLElement | undefined
  let legacyDispose: (() => void) | undefined
  const definitions = new Map<string, MobileClientDefinition>()
  type ExtensionSurfaceEntry = { readonly dispose: () => void; readonly container: HTMLElement; readonly host: () => HTMLElement }
  type ActiveExtension = { readonly controller: AbortController; readonly surfaces: Map<string, ExtensionSurfaceEntry>; readonly cleanup?: () => void }
  const activations = new PerIdActivationLifecycle<ActiveExtension>()
  const styleNodes = new Map<string, HTMLStyleElement>()
  const styleEtags = new Map<string, string>()
  const scriptDigests = new Map<string, string>()
  const activeHostGenerations = new Map<string, string | undefined>()
  const activationKeys = new Map<string, { readonly definition: MobileClientDefinition; readonly generation?: string }>()
  const manifestExtensionIds = new Set<string>()
  const managedDefinitionIds = new Set<string>()
  let manifestEtag = ''
  let disposed = false
  let expectedDefinitionId: string | undefined
  const SURFACE_HOST_STYLES: Readonly<Record<string, string>> = {
    'sidebar-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);left:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'header-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);right:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'composer-dock': 'position:fixed;z-index:1100;bottom:calc(env(safe-area-inset-bottom) + 8px);left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'settings-section': 'position:fixed;z-index:1100;inset:auto 8px calc(env(safe-area-inset-bottom) + 72px) 8px;max-height:40vh;overflow:auto;pointer-events:none',
  }
  const surfaceHost = (placement: string): HTMLElement | undefined => {
    const existing = document.querySelector<HTMLElement>(`[data-dsh-mobile-surface-host="${placement}"]`)
    if (existing !== null) return existing
    const style = SURFACE_HOST_STYLES[placement]
    if (style === undefined) return undefined
    const host = element('div'); host.dataset.dshMobileSurfaceHost = placement; host.style.cssText = style
    document.body.append(host); return host
  }
  const shellLayer = (): HTMLElement => {
    const existing = document.querySelector<HTMLElement>('[data-dsh-mobile-extension-layer]')
    if (existing !== null) return existing
    const layer = element('div'); layer.dataset.dshMobileExtensionLayer = 'true'; layer.style.cssText = 'position:fixed;inset:0;z-index:1200;pointer-events:none;overflow:hidden'
    document.body.append(layer); return layer
  }
  const toast = (message: string): void => {
    const node = element('div'); node.textContent = message; node.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);padding:9px 14px;border-radius:999px;background:#1f2937;color:white;font:14px system-ui;pointer-events:auto;box-shadow:0 8px 24px #0003'
    shellLayer().append(node); window.setTimeout(() => node.remove(), 2600)
  }
  const stopNativeBack = installMobileNativeBack(window, document, () => { toast(mobileBackBlockedMessage(selectedMobileControlLocale())) })
  const materializeNativeFile = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || !('base64' in value) || !('name' in value)) return value
    const candidate = value as { base64?: unknown; name?: unknown; type?: unknown }
    if (typeof candidate.base64 !== 'string' || typeof candidate.name !== 'string') return value
    try {
      const encoded = atob(candidate.base64)
      const bytes = Uint8Array.from(encoded, character => character.charCodeAt(0))
      return new File([bytes], candidate.name, { type: typeof candidate.type === 'string' ? candidate.type : 'application/octet-stream' })
    } catch {
      return value
    }
  }
  const invokeNative = async (action: string, input: unknown, signal: AbortSignal): Promise<unknown> => {
    const abortReason = (): unknown => signal.reason ?? new DOMException('mobile extension disposed', 'AbortError')
    if (signal.aborted) throw abortReason()
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge !== undefined) {
      return invokeBoundNativeCapability(bridge, () => window.__DSH_MOBILE_NATIVE__, action, input, signal).then(materializeNativeFile)
    }
    if (action === 'share' && typeof navigator.share === 'function') { await navigator.share((input ?? {}) as ShareData); return { ok: true } }
    if (action === 'clipboard.read' && navigator.clipboard !== undefined) return { text: await navigator.clipboard.readText() }
    if (action === 'clipboard.write' && navigator.clipboard !== undefined) { await navigator.clipboard.writeText(typeof input === 'object' && input !== null && 'text' in input ? String((input as { text: unknown }).text) : ''); return { ok: true } }
    if (action === 'files.pick' || action === 'camera.capture') {
      const inputElement = element('input')
      inputElement.type = 'file'
      inputElement.accept = action === 'camera.capture' ? 'image/*' : '*/*'
      if (action === 'camera.capture') inputElement.capture = 'environment'
      inputElement.hidden = true
      return new Promise<File | undefined>((resolve, reject) => {
        let settled = false
        let cleaned = false
        let cleanupTimer = 0
        let watchdogTimer = 0
        const cleanup = (): void => {
          if (cleaned) return
          cleaned = true
          if (cleanupTimer !== 0) window.clearTimeout(cleanupTimer)
          if (watchdogTimer !== 0) window.clearTimeout(watchdogTimer)
          window.removeEventListener('focus', scheduleCancel)
          document.removeEventListener('visibilitychange', onVisibilityChange)
          signal.removeEventListener('abort', onAbort)
          inputElement.removeEventListener('change', onChange)
          inputElement.removeEventListener('cancel', onCancel)
          inputElement.remove()
        }
        const finish = (callback: () => void): void => { if (settled) return; settled = true; cleanup(); callback() }
        const onChange = (): void => { const file = inputElement.files?.[0]; finish(() => { resolve(file) }) }
        const onCancel = (): void => { finish(() => { resolve(undefined) }) }
        const onAbort = (): void => { finish(() => { reject(abortReason()) }) }
        const scheduleCancel = (): void => { if (!settled && cleanupTimer === 0) cleanupTimer = window.setTimeout(onCancel, 1000) }
        const onVisibilityChange = (): void => { if (document.visibilityState === 'visible') scheduleCancel() }
        inputElement.addEventListener('change', onChange, { once: true })
        inputElement.addEventListener('cancel', onCancel, { once: true })
        window.addEventListener('focus', scheduleCancel)
        document.addEventListener('visibilitychange', onVisibilityChange)
        signal.addEventListener('abort', onAbort, { once: true })
        watchdogTimer = window.setTimeout(onCancel, 300_000)
        try {
          document.body.append(inputElement)
          inputElement.click()
        } catch (error) {
          finish(() => { reject(error) })
        }
      })
    }
    throw new Error('native capability is unavailable')
  }
  const makeApi = (id: string, hostGeneration: string | undefined, controller: AbortController, surfaces: Map<string, ExtensionSurfaceEntry>, surfaceIds: Set<string>): MobileClientApi => {
    const ensureCurrent = (): void => { if (controller.signal.aborted) throw controller.signal.reason }
    const requestSignal = (signal?: AbortSignal | null): CombinedClientSignal => signal === undefined || signal === null
      ? { signal: controller.signal, cleanup: () => undefined }
      : combineClientSignalLifetime(controller.signal, signal)
    const mountSurface = (surface: MobileSurface): (() => void) => {
      ensureCurrent()
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(surface.id) || surface.label.length > 120) throw new Error('invalid mobile surface')
      return registerUniqueDisposable(surfaces, surfaceIds, surface.id, () => {
        const container = element('section'); container.dataset.dshMobileSurface = surface.id; container.dataset.dshMobileSurfacePlacement = surface.placement; container.hidden = surface.placement === 'page' || surface.placement === 'overlay'; container.style.cssText = surface.placement === 'page' || surface.placement === 'overlay' ? 'position:absolute;inset:0;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;pointer-events:auto' : 'pointer-events:auto'
        const host = (): HTMLElement => surface.placement === 'page' || surface.placement === 'overlay' ? shellLayer() : surfaceHost(surface.placement) ?? shellLayer()
        const mounted = surface.mount(container)
        const dispose = (): void => { try { if (typeof mounted === 'function') mounted() } finally { container.remove() } }
        return { dispose, container, host }
      })
    }
    return {
      host: {
        invoke: (action: string, input: unknown) => {
          ensureCurrent()
          return mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, extensionActionRequestInit(hostGeneration, input, controller.signal)).then(async response => { const value = await response.json() as unknown; if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${String(response.status)}`); return value })
        },
        fetch: (path: string, init?: RequestInit) => {
          ensureCurrent()
          const target = extensionRouteUrl(id, path, location.href)
          const headers = extensionGenerationHeaders(hostGeneration, init?.headers)
          const lifetime = requestSignal(init?.signal)
          return mobileRequest(target.href, { ...init, headers, signal: lifetime.signal }).then(
            response => bindClientResponseLifetime(response, lifetime.cleanup),
            error => { lifetime.cleanup(); throw error },
          )
        },
        assetUrl: path => { ensureCurrent(); return extensionAssetUrl(id, hostGeneration, path, location.href).href },
      },
      ui: {
        registerSurface: mountSurface,
        open: surfaceId => { ensureCurrent(); const entry = surfaces.get(surfaceId); if (entry !== undefined) setMobileSurfaceOpen(entry.container, true) },
        close: surfaceId => { ensureCurrent(); const entry = surfaces.get(surfaceId); if (entry !== undefined) setMobileSurfaceOpen(entry.container, false) },
        toast: message => { ensureCurrent(); toast(message) },
      },
      native: {
        capabilities: async () => { ensureCurrent(); const bridge = window.__DSH_MOBILE_NATIVE__; return bridge === undefined ? ['files.pick', 'camera.capture', 'share', 'clipboard.read', 'clipboard.write'] : bridge.capabilities() },
        invoke: (action, input) => invokeNative(action, input, controller.signal),
      },
      signal: controller.signal, document, window,
    }
  }
  const activateDefinition = (definition: MobileClientDefinition, cycleSignal?: AbortSignal, commitGeneration?: () => void, hostGeneration?: string): Promise<boolean> => {
    const previousKey = activationKeys.get(definition.id)
    const key = previousKey?.definition === definition && previousKey.generation === hostGeneration
      ? previousKey
      : { definition, ...(hostGeneration === undefined ? {} : { generation: hostGeneration }) }
    activationKeys.set(definition.id, key)
    return activations.activate(
    definition.id,
    key,
    cycleSignal,
    controller => {
      const surfaces = new Map<string, ExtensionSurfaceEntry>()
      const surfaceIds = new Set<string>()
      let pendingDisposed = false
      const disposePending = (): void => {
        if (pendingDisposed) return
        pendingDisposed = true
        for (const surface of surfaces.values()) {
          try { surface.dispose() } catch { /* Dispose every staged surface independently. */ }
        }
        surfaces.clear()
        surfaceIds.clear()
      }
      const result = Promise.resolve().then(() => definition.activate(makeApi(definition.id, hostGeneration, controller, surfaces, surfaceIds))).then(cleanup => ({
        controller,
        surfaces,
        ...(typeof cleanup === 'function' ? { cleanup } : {}),
      }))
      return {
        result,
        cancel: disposePending,
        commit: value => {
          if (definitions.get(definition.id) !== definition || controller.signal.aborted) throw new Error('stale mobile extension activation')
          for (const surface of value.surfaces.values()) surface.host().append(surface.container)
          activeHostGenerations.set(definition.id, hostGeneration)
          commitGeneration?.()
        },
        dispose: value => {
          controller.abort(new DOMException('mobile extension disposed', 'AbortError'))
          try { value.cleanup?.() } finally { disposePending() }
        },
      }
    },
    )
  }
  const define = (definition: MobileClientDefinition): void => {
    if (disposed || definition.apiVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/u.test(definition.id) || typeof definition.activate !== 'function') return
    if (expectedDefinitionId !== undefined && definition.id !== expectedDefinitionId) return
    definitions.set(definition.id, definition)
    if (started && expectedDefinitionId === undefined) void activateDefinition(definition)
  }
  let started = false
  window.dshMobile = Object.freeze({ register: mount => { legacyMount = mount }, define })
  for (const definition of queuedDefinitions.splice(0)) define(definition)
  let legacyJsEtag = ''
  let legacyJsModified = ''
  const refreshLegacy = async (signal: AbortSignal): Promise<boolean> => {
    const previousMount = legacyMount
    let pendingRoot: HTMLElement | undefined
    try {
      const headers: Record<string, string> = {}
      if (legacyJsEtag !== '') headers['if-none-match'] = legacyJsEtag
      if (legacyJsModified !== '') headers['if-modified-since'] = legacyJsModified
      const response = await fetch('/mobile-access/custom.js', { credentials: 'same-origin', cache: 'no-store', headers, signal })
      if (response.status === 304) return true
      if (!response.ok) return false
      const nextEtag = response.headers.get('etag') ?? ''
      const nextModified = response.headers.get('last-modified') ?? ''
      const next = await response.text()
      if (refreshAborted(signal)) return false
      if (next === legacySource) { legacyJsEtag = nextEtag; legacyJsModified = nextModified; return true }
      legacyMount = undefined
      const script = element('script'); script.textContent = `${next}\n//# sourceURL=dsh-mobile-custom.js`; document.head.append(script); script.remove()
      if (refreshAborted(signal)) { legacyMount = previousMount; return false }
      const mount = legacyMount as MobileExtensionMount | undefined
      if (mount === undefined) {
        legacyDispose?.(); legacyDispose = undefined
        legacyRoot?.remove(); legacyRoot = undefined
        legacySource = next; legacyJsEtag = nextEtag; legacyJsModified = nextModified
        return true
      }
      const nextRoot = element('div'); pendingRoot = nextRoot; nextRoot.dataset.dshMobileExtension = 'true'; document.body.append(nextRoot)
      const nextDispose = mount({ document, request: mobileRequest, root: nextRoot, window })
      if (refreshAborted(signal)) { if (typeof nextDispose === 'function') nextDispose(); pendingRoot.remove(); pendingRoot = undefined; legacyMount = previousMount; return false }
      legacyDispose?.(); legacyRoot?.remove(); legacyRoot = nextRoot; pendingRoot = undefined; legacyDispose = typeof nextDispose === 'function' ? nextDispose : undefined; legacySource = next
      legacyJsEtag = nextEtag; legacyJsModified = nextModified
      return true
    } catch { pendingRoot?.remove(); legacyMount = previousMount; return false }
  }
  let legacyScriptRevision = ''
  let legacyStyleRevision = ''
  const disposeManifestExtension = (id: string): void => {
    activations.remove(id)
    styleNodes.get(id)?.remove(); styleNodes.delete(id); styleEtags.delete(id); scriptDigests.delete(id); activeHostGenerations.delete(id); activationKeys.delete(id)
    if (managedDefinitionIds.delete(id)) definitions.delete(id)
  }
  const managedManifestIdSources = (): readonly Iterable<string>[] => [styleNodes.keys(), styleEtags.keys(), scriptDigests.keys(), managedDefinitionIds]
  const clearManifestExtensions = (): void => {
    publishAuthoritativeExtensionIds(manifestExtensionIds, new Set(), managedManifestIdSources(), disposeManifestExtension)
    manifestEtag = ''
  }
  const refreshExtensions = async (signal: AbortSignal): Promise<boolean> => {
    try {
      const headers: Record<string, string> = {}
      if (manifestEtag !== '') headers['if-none-match'] = manifestEtag
      const response = await fetch('/mobile-access/extensions/manifest', { credentials: 'same-origin', cache: 'no-store', headers, signal })
      if (response.status === 404) {
        legacyScriptRevision = ''
        legacyStyleRevision = ''
        return handleMissingExtensionManifest(
          clearManifestExtensions,
          () => Promise.all([refreshLegacy(signal), refreshCssLegacy(legacyStyle, signal, legacyCssState)]),
          signal,
        )
      }
      if (response.status === 304) return true
      if (!response.ok) return false
      const nextManifestEtag = response.headers.get('etag') ?? ''
      const payload = parseMobileExtensionManifest(await response.json())
      if (refreshAborted(signal) || payload === undefined) return false
      const entries = payload.extensions
      const seen = new Set(entries.map(entry => entry.id))
      const scriptRevision = payload.legacy.scriptRevision
      const styleRevision = payload.legacy.styleRevision
      let refreshComplete = true
      if (scriptRevision === '' || scriptRevision !== legacyScriptRevision) {
        if (await refreshLegacy(signal)) legacyScriptRevision = scriptRevision
        else refreshComplete = false
      }
      if (styleRevision === '' || styleRevision !== legacyStyleRevision) {
        if (await refreshCssLegacy(legacyStyle, signal, legacyCssState)) legacyStyleRevision = styleRevision
        else refreshComplete = false
      }
      const commitStyle = (id: string, change: 'retain' | 'remove' | 'replace', css?: string, etag?: string): void => {
        if (change === 'retain') return
        const oldStyle = styleNodes.get(id)
        if (change === 'remove') {
          oldStyle?.remove()
          styleNodes.delete(id)
          styleEtags.delete(id)
          return
        }
        if (oldStyle?.textContent !== css) {
          const node = element('style'); node.dataset.dshMobileExtensionStyle = id; node.textContent = css ?? ''; document.head.append(node); styleNodes.set(id, node); oldStyle?.remove()
        }
        if (etag !== undefined && etag !== '') styleEtags.set(id, etag)
      }
      for (const entry of entries) {
        const hadActiveGeneration = activations.hasActive(entry.id)
        const previousHostGeneration = activeHostGenerations.get(entry.id)
        let previousDefinition: MobileClientDefinition | undefined
        let evaluatedDefinition = false
        try {
          let styleChange: 'retain' | 'remove' | 'replace' = entry.styleUrl === undefined ? 'remove' : 'retain'
          let pendingCss: string | undefined
          let pendingStyleEtag: string | undefined
          const cssUrl = typeof entry.styleUrl === 'string' ? entry.styleUrl : undefined
          if (cssUrl !== undefined) {
            const cssHeaders: Record<string, string> = {}
            const storedEtag = styleEtags.get(entry.id)
            if (storedEtag !== undefined) cssHeaders['if-none-match'] = storedEtag
            const cssResponse = await fetch(cssUrl, { credentials: 'same-origin', cache: 'no-store', headers: cssHeaders, signal })
            if (cssResponse.status !== 304) {
              if (!cssResponse.ok) throw new Error('mobile extension style failed to load')
              pendingStyleEtag = cssResponse.headers.get('etag') ?? undefined
              pendingCss = await cssResponse.text()
              styleChange = 'replace'
              if (refreshAborted(signal)) return false
            }
          }

          const scriptUrl = typeof entry.scriptUrl === 'string' ? entry.scriptUrl : undefined
          if (scriptUrl === undefined) {
            if (refreshAborted(signal)) return false
            commitStyle(entry.id, styleChange, pendingCss, pendingStyleEtag)
            activations.remove(entry.id)
            activeHostGenerations.delete(entry.id)
            scriptDigests.delete(entry.id)
            if (managedDefinitionIds.delete(entry.id)) definitions.delete(entry.id)
          } else {
            const scriptHeaders: Record<string, string> = {}
            const storedDigest = scriptDigests.get(entry.id)
            if (storedDigest !== undefined) scriptHeaders['if-none-match'] = storedDigest
            const scriptResponse = await fetch(scriptUrl, { credentials: 'same-origin', cache: 'no-store', headers: scriptHeaders, signal })
            let nextDigest: string | undefined
            if (scriptResponse.status !== 304) {
              if (!scriptResponse.ok) throw new Error('mobile extension script failed to load')
              const source = await scriptResponse.text()
              if (refreshAborted(signal)) return false
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
              if (refreshAborted(signal)) return false
              const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
              if (scriptDigests.get(entry.id) !== key) {
                previousDefinition = definitions.get(entry.id)
                try {
                  expectedDefinitionId = entry.id
                  try {
                    const script = element('script'); script.textContent = `${source}\n//# sourceURL=dsh-mobile-extension-${entry.id}.js`; document.head.append(script); script.remove()
                  } finally { expectedDefinitionId = undefined }
                  const nextDefinition = definitions.get(entry.id)
                  if (nextDefinition === undefined || nextDefinition === previousDefinition) throw new Error('mobile extension did not define its manifest id')
                  evaluatedDefinition = true
                  nextDigest = key
                } catch (error) {
                  if (previousDefinition === undefined) definitions.delete(entry.id)
                  else definitions.set(entry.id, previousDefinition)
                  throw error
                }
              }
            }
            const definition = definitions.get(entry.id)
            const commitGeneration = (): void => { commitStyle(entry.id, styleChange, pendingCss, pendingStyleEtag) }
            if (definition === undefined) throw new Error('mobile extension definition is unavailable')
            if (evaluatedDefinition || !activations.hasActive(entry.id) || activeHostGenerations.get(entry.id) !== entry.generation) {
              if (!await activateDefinition(definition, signal, commitGeneration, entry.generation)) throw new Error('mobile extension activation failed')
            } else {
              if (refreshAborted(signal)) return false
              commitGeneration()
            }
            managedDefinitionIds.add(entry.id)
            if (nextDigest !== undefined) scriptDigests.set(entry.id, nextDigest)
          }
        } catch {
          if (evaluatedDefinition) {
            if (previousDefinition === undefined) definitions.delete(entry.id)
            else definitions.set(entry.id, previousDefinition)
          }
          failClosedExtensionGenerationReplacement(
            hadActiveGeneration,
            previousHostGeneration,
            entry.generation,
            () => { disposeManifestExtension(entry.id) },
          )
          refreshComplete = false
        }
      }
      if (refreshAborted(signal)) return false
      if (refreshComplete) {
        publishAuthoritativeExtensionIds(manifestExtensionIds, seen, managedManifestIdSources(), disposeManifestExtension)
        manifestEtag = nextManifestEtag
      } else manifestEtag = ''
      return refreshComplete
    } catch { return false }
  }
  started = true
  for (const definition of definitions.values()) void activateDefinition(definition)
  const stopRefresh = startLifecycleRefreshScheduler(async signal => {
    await refreshExtensions(signal)
  })
  const stopEvents = startExtensionChangeStream(
    () => { stopRefresh.refresh() },
    undefined,
    payload => {
      // Host-pushed task completion: exact, no guessing. Each completed turn
      // keeps its own notification, and generic text avoids attributing a
      // background task to whichever session happens to be open on the phone.
      if (document.hidden !== true) return
      const parsed = parseTaskNotifyPayload(payload)
      if (parsed === undefined) return
      const language = resolveNativeMobileLanguage(
        document.documentElement.lang,
        navigator.languages.length > 0 ? [...navigator.languages] : [navigator.language],
      )
      const label = (italian: string, english: string, chinese: string): string =>
        language === 'it' ? italian : language === 'zh' ? chinese : english
      fireTaskNotifyEvent({
        kind: 'done',
        title: label('Attività completata', 'Task finished', '任务已完成'),
        body: label('Il tuo task DSH è terminato', 'Your DSH task finished', '你的 DSH 任务已完成'),
        tag: taskCompletionTag(parsed.sessionId, parsed.turn),
      })
    },
    () => { fireDeviceRevoked() },
  )
  return () => { disposed = true; stopNativeBack(); stopEvents(); stopRefresh(); started = false; legacyDispose?.(); legacyDispose = undefined; legacyRoot?.remove(); legacyRoot = undefined; legacyStyle.remove(); activations.dispose(); for (const node of styleNodes.values()) node.remove(); styleNodes.clear(); const layer = document.querySelector('[data-dsh-mobile-extension-layer]'); layer?.remove(); for (const host of document.querySelectorAll('[data-dsh-mobile-surface-host]')) host.remove(); if (previous === undefined) delete window.dshMobile; else window.dshMobile = previous }
}

interface LegacyCssState { etag: string; modified: string }
async function refreshCssLegacy(style: HTMLStyleElement, signal: AbortSignal, state: LegacyCssState): Promise<boolean> {
  try {
    const headers: Record<string, string> = {}
    if (state.etag !== '') headers['if-none-match'] = state.etag
    if (state.modified !== '') headers['if-modified-since'] = state.modified
    let response = await fetch('/mobile-access/custom.css', { credentials: 'same-origin', cache: 'no-store', headers, signal })
    if (response.status === 304 && style.textContent === '') {
      state.etag = ''
      state.modified = ''
      response = await fetch('/mobile-access/custom.css', { credentials: 'same-origin', cache: 'no-store', signal })
    }
    if (response.status === 304) return true
    if (response.ok) {
      const nextEtag = response.headers.get('etag') ?? ''
      const nextModified = response.headers.get('last-modified') ?? ''
      const css = await response.text()
      if (refreshAborted(signal)) return false
      style.textContent = css
      state.etag = nextEtag
      state.modified = nextModified
      return true
    }
    return false
  } catch { return false }
}

/** Theme-aware desktop Mobile Access panel styles. */
export const CONTROL_STYLES = `
.dsh-mobile-control{position:fixed;z-index:1000;inset:0;pointer-events:none;font:14px/1.45 system-ui;color:var(--dsw-alias-label-primary,#16181d)}
/* The settings surface is a centered modal window over a dimmed backdrop, not a
   sidebar-anchored card. The phone shell keeps the full-width bottom sheet. */
.dsh-mobile-control__window{position:absolute;inset:0}
.dsh-mobile-control__backdrop{position:absolute;inset:0;background:rgb(15 23 42 / 45%);backdrop-filter:blur(2px);pointer-events:auto;animation:dsh-control-fade 160ms ease-out both}
.dsh-mobile-control__backdrop[hidden]{display:none}
.dsh-mobile-control__panel{box-sizing:border-box;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,calc(100vw - 32px));max-height:min(88vh,calc(100vh - 48px));overflow-y:auto;overscroll-behavior:contain;padding:16px;border:1px solid var(--dsw-alias-border-l2,#e1e5eb);border-radius:16px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 24px 70px rgb(15 23 42 / 32%);pointer-events:auto;animation:dsh-control-window 180ms ease-out both}
/* Phone shell: the panel becomes a full-width bottom sheet instead of a
   centered window, and keeps clear of the home indicator. */
@media(max-width:599px){
.dsh-mobile-control__panel{left:0;right:0;top:auto;bottom:0;transform:none;width:100%;max-height:min(86dvh,calc(100dvh - 64px));border-radius:18px 18px 0 0;border-bottom:0;padding-bottom:calc(16px + env(safe-area-inset-bottom));animation:dsh-control-sheet 200ms ease-out both}
}
@keyframes dsh-control-window{from{opacity:0;transform:translate(-50%,-50%) scale(.97)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
@keyframes dsh-control-sheet{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
@keyframes dsh-control-fade{from{opacity:0}to{opacity:1}}
.dsh-mobile-control__header{position:sticky;top:-16px;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-16px -16px 10px;padding:12px 16px 10px;background:var(--dsw-alias-bg-layer-2,#fff);border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__panel h2{margin:0;font-size:17px;line-height:24px}.dsh-mobile-control__header-actions{display:flex;align-items:center;gap:2px}.dsh-mobile-control__update-plugin,.dsh-mobile-control__diagnostic-entry,.dsh-mobile-control__close{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer}.dsh-mobile-control__update-plugin,.dsh-mobile-control__diagnostic-entry{padding:0 8px;color:var(--dsw-alias-label-primary-bluish,#2563eb);font:650 12px/1 system-ui;white-space:nowrap}.dsh-mobile-control__update-plugin[hidden]{display:none}.dsh-mobile-control__update-plugin:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__close{font-size:24px;line-height:1}.dsh-mobile-control__update-plugin:hover:not(:disabled),.dsh-mobile-control__diagnostic-entry:hover,.dsh-mobile-control__close:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-mobile-control__release-notice{margin:-2px 0 10px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#eff6ff);color:var(--dsw-alias-label-primary,#1d4ed8);font-size:11px;line-height:1.45}.dsh-mobile-control__release-notice.is-error{color:var(--dsw-alias-label-primary,#dc2626);border-left:3px solid var(--dsw-alias-state-error-primary,#dc2626)}.dsh-mobile-control__release-notice[hidden]{display:none}.dsh-mobile-control__update-card{margin:0 0 10px;padding:11px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__update-card[hidden]{display:none}.dsh-mobile-control__update-card-title{margin:0 0 7px;color:var(--dsw-alias-label-primary,#16181d);font:650 13px/1.4 system-ui}.dsh-mobile-control__update-notes{display:block;box-sizing:border-box;max-height:150px;overflow-y:auto;margin:0 0 8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e1e5eb);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#475569);white-space:pre-wrap;word-break:break-word;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.dsh-mobile-control__update-notes[hidden]{display:none}.dsh-mobile-control__update-notice{margin:0 0 9px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-state-warn-tertiary,#fff4d6);color:var(--dsw-alias-state-warn-label,#92400e);font-size:11px;line-height:1.5}.dsh-mobile-control__update-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}.dsh-mobile-control__update-actions .dsh-mobile-control__primary,.dsh-mobile-control__update-actions .dsh-mobile-control__secondary{min-height:36px;padding:0 12px}.dsh-mobile-control__app-download{display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;min-height:44px;margin:0 0 10px;padding:8px 11px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-primary,#16181d);font:600 12px/1.3 system-ui;text-decoration:none}.dsh-mobile-control__app-download[hidden]{display:none}.dsh-mobile-control__app-download::after{color:var(--dsw-alias-label-primary-bluish,#2563eb);font-size:14px;content:"↗"}.dsh-mobile-control__app-download:hover{border-color:#9fb9e8;background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-2,#f5f8ff));color:var(--dsw-alias-label-primary,#1d4ed8)}
.dsh-mobile-control__switcher{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;margin:0 0 14px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#f3f5f8)}.dsh-mobile-control__switcher[hidden]{display:none}.dsh-mobile-control__tab{min-height:36px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#606873);font:600 13px/1 system-ui;cursor:pointer}.dsh-mobile-control__tab.is-active{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);box-shadow:0 1px 3px rgb(15 23 42 / 10%)}.dsh-mobile-control__view[hidden]{display:none}.dsh-mobile-control__intro{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px;line-height:1.55}.dsh-mobile-control__http-frame-warning{box-sizing:border-box;margin:-4px 0 12px;padding:8px 10px;border:1px solid #d6a83f;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff7df);color:var(--dsw-alias-label-primary,#694b00);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.dsh-mobile-control__http-frame-warning[hidden]{display:none}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions button[hidden]{display:none}
.dsh-mobile-control__provider-section{position:relative;margin:0 0 14px}.dsh-mobile-control__section-title{margin:0 0 8px;color:var(--dsw-alias-label-primary,#16181d);font:650 13px/1.4 system-ui}.dsh-mobile-control__provider-section>.dsh-mobile-control__section-title{padding-right:42px}.dsh-mobile-control__provider-choices{display:grid;grid-template-columns:1fr;gap:8px}.dsh-mobile-control__provider{display:flex;min-width:0;flex-direction:column;gap:6px;min-height:94px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);text-align:left;cursor:pointer;touch-action:manipulation;transition:border-color 160ms ease,background-color 160ms ease,box-shadow 160ms ease}.dsh-mobile-control__provider:hover{border-color:#6f96db;background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-1,#f8fbff))}.dsh-mobile-control__provider.is-selected{border-color:var(--dsw-alias-label-primary-bluish,#2563eb);background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-1,#f5f8ff));box-shadow:0 0 0 1px var(--dsw-alias-label-primary-bluish,#2563eb) inset}.dsh-mobile-control__provider:disabled{cursor:wait;opacity:.62}.dsh-mobile-control__provider-top{display:flex;min-width:0;align-items:flex-start;justify-content:space-between;gap:5px}.dsh-mobile-control__provider-top strong{min-width:0;font-size:12px;line-height:1.3}.dsh-mobile-control__provider-badge{flex:none;padding:2px 5px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,#e8f0ff);color:var(--dsw-alias-label-primary,#1d4ed8);font:650 11px/1.25 system-ui}.dsh-mobile-control__provider-badge.is-cpolar{background:var(--dsw-alias-state-success-tertiary,#eaf8f2);color:var(--dsw-alias-label-primary,#087454)}.dsh-mobile-control__provider-description{color:var(--dsw-alias-label-secondary,#606873);font-size:12px;line-height:1.45}.dsh-mobile-control__provider-info{position:absolute;z-index:5;top:-13px;right:-8px}.dsh-mobile-control__provider-info-button{display:flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#475569);cursor:pointer;touch-action:manipulation}.dsh-mobile-control__provider-info-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f5f9);color:var(--dsw-alias-label-primary-bluish,#2563eb)}.dsh-mobile-control__provider-info-glyph{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:18px;height:18px;border:1.5px solid currentColor;border-radius:50%;font:700 12px/1 system-ui}.dsh-mobile-control__provider-info-popover{position:absolute;z-index:6;top:38px;right:4px;box-sizing:border-box;width:min(292px,calc(100vw - 72px));padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 10px 28px rgb(15 23 42 / 16%)}.dsh-mobile-control__provider-info-popover[hidden]{display:none}.dsh-mobile-control__provider-info-popover strong,.dsh-mobile-control__provider-info-popover span{display:block}.dsh-mobile-control__provider-info-popover strong{margin-bottom:3px;font-size:12px}.dsh-mobile-control__provider-info-popover span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}
/* The managed-component setup cards (cloudflared, SakuraFrp) deliberately reuse this card, so
   .dsh-mobile-control__cloudflared-setup and .dsh-mobile-control__sakurafrp-setup are DOM hooks
   for targeting rather than style rules of their own. */
.dsh-mobile-control__cpolar-setup{margin:0 0 12px;padding:12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__cpolar-setup[hidden],.dsh-mobile-control__cpolar-account[hidden],.dsh-mobile-control__details[hidden],.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions[hidden],.dsh-mobile-control__danger[hidden]{display:none}.dsh-mobile-control__component-status,.dsh-mobile-control__component-note{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}.dsh-mobile-control__cpolar-setup>.dsh-mobile-control__primary{width:100%;min-height:44px;padding:9px 12px;border-radius:10px;font:600 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__cpolar-account{margin-top:10px}.dsh-mobile-control__link-row{display:flex;flex-wrap:wrap;gap:6px 12px;margin:0 0 10px}.dsh-mobile-control__text-link{color:var(--dsw-alias-label-primary-bluish,#2563eb);font-size:11px;text-decoration:none}.dsh-mobile-control__text-link:hover{text-decoration:underline}.dsh-mobile-control__token-label{display:flex;flex-direction:column;gap:5px;margin:0 0 8px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__token{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-label-primary,#16181d);font:16px/1.4 system-ui}.dsh-mobile-control__cpolar-connect{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:44px;padding:10px 14px;border-radius:12px;font:650 13px/1.2 system-ui;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease,opacity 160ms ease}.dsh-mobile-control__cpolar-connect:hover:not(:disabled){border-color:#1d4ed8;background:#1d4ed8}.dsh-mobile-control__cpolar-connect:active:not(:disabled){border-color:#1e40af;background:#1e40af}.dsh-mobile-control__cpolar-connect:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__details{margin:10px 0 0;border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb);padding-top:9px}.dsh-mobile-control__details>summary{min-height:36px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:30px;cursor:pointer}.dsh-mobile-control__details-body{display:flex;flex-wrap:wrap;align-items:center;gap:7px 12px;padding:4px 0}.dsh-mobile-control__details-body p{flex:1 0 100%;margin:0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__storage{display:block;flex:1 0 100%;max-width:100%;overflow:hidden;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-secondary,#475569);font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__danger{flex:1 0 100%;min-height:44px;margin-top:3px;padding:7px 10px;border:1px solid var(--dsw-alias-state-error-primary,#dc2626);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#dc2626);font:12px/1.3 system-ui;cursor:pointer}
.dsh-mobile-control__danger:hover:not(:disabled),.dsh-mobile-control__device-revoke:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgb(220 38 38 / 8%))}
.dsh-mobile-control__frp-fields{display:grid;grid-template-columns:minmax(0,1fr) 96px;gap:8px}.dsh-mobile-control__frp-fields>.dsh-mobile-control__field:nth-child(5),.dsh-mobile-control__frp-fields>.dsh-mobile-control__field:nth-child(6){grid-column:1/-1}.dsh-mobile-control__frp-fields>.dsh-mobile-control__field[hidden]{display:none}.dsh-mobile-control__frp-fields select{box-sizing:border-box;width:100%;min-height:44px;padding:9px 32px 9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:14px/1.4 system-ui}.dsh-mobile-control__frp-fields select:disabled{cursor:not-allowed;opacity:.55}.dsh-mobile-control__frp-hint{margin:0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__field{display:flex;min-width:0;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__field:nth-child(3),.dsh-mobile-control__field:nth-child(4){grid-column:1/-1}.dsh-mobile-control__field input{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:16px/1.4 system-ui}.dsh-mobile-control__frp-action{box-sizing:border-box;width:100%;min-height:44px;padding:9px 12px;border-radius:10px;font:650 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__frp-action:disabled{cursor:not-allowed;opacity:.5}.dsh-mobile-control__remote-workspace{margin:0;padding:12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:15px;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}.dsh-mobile-control__stage-header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.dsh-mobile-control__stage-header .dsh-mobile-control__section-title{margin:0}.dsh-mobile-control__stage-meta{display:flex;min-width:0;align-items:center;justify-content:flex-end;gap:5px}.dsh-mobile-control__stage-value{max-width:115px;overflow:hidden;color:var(--dsw-alias-label-primary,#16181d);font:650 11px/1.3 system-ui;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__state-badge{flex:none;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#606873);font:650 11px/1.25 system-ui}.dsh-mobile-control__state-badge.is-ready{background:var(--dsw-alias-state-success-tertiary,#e6f7f0);color:var(--dsw-alias-label-primary,#087454)}.dsh-mobile-control__state-badge.is-busy{background:var(--dsw-alias-state-business-tertiary,#e8f0ff);color:var(--dsw-alias-label-primary,#1d4ed8)}.dsh-mobile-control__state-badge.is-attention{background:var(--dsw-alias-state-warn-tertiary,#fff4dc);color:var(--dsw-alias-label-primary,#935100)}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__status{box-sizing:border-box;margin:0 0 10px;padding:9px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);font-size:11px;line-height:1.45}.dsh-mobile-control__provider-setup-body{margin:0 0 10px}.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__cpolar-setup{margin:0}.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__cpolar-setup>.dsh-mobile-control__section-title:first-of-type{display:none}.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__details{margin:0;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__actions{margin-top:2px}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__qr{margin:10px 0 0}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__manage-row{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}
.dsh-mobile-control__tunnel{margin:0 0 10px}.dsh-mobile-control__tunnel[hidden]{display:none}
.dsh-mobile-control__lan-setup{box-sizing:border-box;margin:0 0 12px;padding:14px;border:1px solid #6f96db;border-radius:15px;background:var(--dsw-alias-bg-layer-1,#f5f8ff)}.dsh-mobile-control__lan-setup[hidden],.dsh-mobile-control__lan-setup-form[hidden]{display:none}.dsh-mobile-control__lan-setup>.dsh-mobile-control__section-title{margin-bottom:5px}.dsh-mobile-control__lan-setup>.dsh-mobile-control__intro{margin-bottom:12px}.dsh-mobile-control__lan-setup-form{display:grid;gap:9px}.dsh-mobile-control__lan-setup .dsh-mobile-control__field select{box-sizing:border-box;width:100%;min-height:44px;padding:9px 32px 9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:14px/1.4 system-ui}.dsh-mobile-control__lan-setup .dsh-mobile-control__component-note{margin:0}.dsh-mobile-control__lan-setup-actions{display:grid;grid-template-columns:1fr 1.35fr;gap:8px}.dsh-mobile-control__lan-setup-actions button{box-sizing:border-box;min-width:0;min-height:44px;padding:9px 10px;border-radius:10px;font:650 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__lan-setup-actions button:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__lan-setup>.dsh-mobile-control__status{margin:10px 0 0;line-height:1.5}.dsh-mobile-control__lan-setup>.dsh-mobile-control__status:empty{display:none}
.dsh-mobile-control__access{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0 0 12px}.dsh-mobile-control__access[hidden]{display:none}.dsh-mobile-control__access-label{flex:none;color:var(--dsw-alias-label-secondary,#606873);white-space:nowrap}.dsh-mobile-control__access-label::after{content:"："}.dsh-mobile-control__access-link{min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary-bluish,#2563eb);text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__access-link:hover{text-decoration:underline}.dsh-mobile-control__qr{display:flex;justify-content:center;margin:0 0 12px}.dsh-mobile-control__qr[hidden]{display:none}.dsh-mobile-control__qr img{border-radius:12px;background:#fff;padding:8px}
.dsh-mobile-control__status{margin:0 0 14px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#606873)}.dsh-mobile-control__status::before{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#98a1ad);content:""}.dsh-mobile-control__status.is-running::before{background:var(--dsw-alias-state-success-primary,#16a36a)}.dsh-mobile-control__status.is-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.dsh-mobile-control__extensions{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px}
.dsh-mobile-control__view.is-diagnostics{--dsh-diagnostic-ok:var(--dsw-alias-state-success-primary,#087454);--dsh-diagnostic-warning:var(--dsw-alias-state-warn-primary,#a35b00);--dsh-diagnostic-error:var(--dsw-alias-state-error-primary,#c62828);--dsh-diagnostic-info:var(--dsw-alias-label-secondary,#526071)}.dsh-mobile-control__diagnostic-summary{box-sizing:border-box;margin:0;padding:13px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__diagnostic-summary-main{display:grid;grid-template-columns:36px minmax(0,1fr);align-items:center;gap:11px}.dsh-mobile-control__diagnostic-summary-icon{position:relative;display:block;width:36px;height:36px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#e8edf3);color:var(--dsh-diagnostic-info)}.dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-summary-icon::after{position:absolute;content:""}.dsh-mobile-control__diagnostic-summary-body{display:flex;min-width:0;flex-direction:column;gap:2px}.dsh-mobile-control__diagnostic-summary-body strong{font-size:13px;line-height:1.35}.dsh-mobile-control__diagnostic-summary-body span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__diagnostic-summary-meta{display:block;margin-top:11px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l2,#dbe1e8);color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.45}.dsh-mobile-control__diagnostic-summary.is-ok .dsh-mobile-control__diagnostic-summary-icon{background:var(--dsw-alias-state-success-tertiary,#e6f7f0);color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-summary.is-ok .dsh-mobile-control__diagnostic-summary-icon::before{top:10px;left:10px;width:13px;height:7px;border-bottom:2px solid currentColor;border-left:2px solid currentColor;transform:rotate(-45deg)}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon{background:var(--dsw-alias-state-warn-tertiary,#fff4dc);color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon{background:var(--dsw-alias-state-error-secondary,#fdecec);color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:13px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon::after,.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon::after{bottom:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon{background:var(--dsw-alias-state-business-tertiary,#e8f0ff);color:var(--dsw-alias-label-primary-bluish,#2563eb)}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon::before{inset:9px;border:2px solid rgb(37 99 235 / 24%);border-top-color:currentColor;border-radius:50%;animation:dsh-diagnostic-spin .8s linear infinite}
.dsh-mobile-control__diagnostic-summary.is-idle .dsh-mobile-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-idle .dsh-mobile-control__diagnostic-summary-icon::after{top:13px;left:17px;width:2px;height:11px;border-radius:2px;background:currentColor}
.dsh-mobile-control__diagnostic-toolbar{display:grid;grid-template-columns:1fr;gap:8px;margin-top:10px}.dsh-mobile-control__diagnostic-toolbar.has-report{grid-template-columns:1fr 1fr}.dsh-mobile-control__diagnostic-run,.dsh-mobile-control__diagnostic-copy{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border-radius:11px;font:650 12px/1.3 system-ui;cursor:pointer;touch-action:manipulation}.dsh-mobile-control__diagnostic-copy[hidden]{display:none}.dsh-mobile-control__diagnostic-run:disabled{cursor:wait;opacity:.58}.dsh-mobile-control__diagnostic-feedback{margin:8px 0 0;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-state-business-tertiary,#eff6ff);color:var(--dsw-alias-label-primary,#1d4ed8);font-size:11px;line-height:1.45}.dsh-mobile-control__diagnostic-feedback[hidden]{display:none}
.dsh-mobile-control__diagnostic-checks{display:grid;gap:12px;margin-top:12px;animation:dsh-diagnostic-reveal 160ms ease-out both}.dsh-mobile-control__diagnostic-checks[hidden]{display:none}.dsh-mobile-control__diagnostic-group{overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__diagnostic-group-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 11px;border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5eb);background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__diagnostic-group-header h3{margin:0;font:650 11px/1.4 system-ui}.dsh-mobile-control__diagnostic-group-header span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__diagnostic-list{display:flex;flex-direction:column}.dsh-mobile-control__diagnostic-check{display:grid;grid-template-columns:26px minmax(0,1fr);gap:9px;padding:11px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__diagnostic-check + .dsh-mobile-control__diagnostic-check{border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__diagnostic-marker{position:relative;width:26px;height:26px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#edf1f5);color:var(--dsh-diagnostic-info)}.dsh-mobile-control__diagnostic-marker::before,.dsh-mobile-control__diagnostic-marker::after{position:absolute;content:""}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-marker{background:var(--dsw-alias-state-success-tertiary,#e6f7f0);color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-marker::before{top:7px;left:7px;width:9px;height:5px;border-bottom:1.8px solid currentColor;border-left:1.8px solid currentColor;transform:rotate(-45deg)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker{background:var(--dsw-alias-state-warn-tertiary,#fff4dc);color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker{background:var(--dsw-alias-state-error-secondary,#fdecec);color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker::before,.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker::after,.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker::after{bottom:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-check.is-info .dsh-mobile-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-check.is-info .dsh-mobile-control__diagnostic-marker::after{top:10px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-check-body{min-width:0}.dsh-mobile-control__diagnostic-check-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.dsh-mobile-control__diagnostic-check-header strong{min-width:0;font-size:12px;line-height:1.4}.dsh-mobile-control__diagnostic-badge{flex:none;padding:2px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#edf1f5);color:var(--dsh-diagnostic-info);font:650 11px/1.3 system-ui}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-badge{background:var(--dsw-alias-state-success-tertiary,#e6f7f0);color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-badge{background:var(--dsw-alias-state-warn-tertiary,#fff4dc);color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-badge{background:var(--dsw-alias-state-error-secondary,#fdecec);color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-check p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.dsh-mobile-control__diagnostic-check .dsh-mobile-control__diagnostic-action{margin-top:7px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f8fafc);color:var(--dsw-alias-label-primary,#16181d)}.dsh-mobile-control__diagnostic-action span{display:inline-block;margin-right:6px;color:var(--dsw-alias-label-primary-bluish,#2563eb);font-weight:700}.dsh-mobile-control__diagnostic-details{margin-top:12px}.dsh-mobile-control__diagnostic-details[hidden]{display:none}.dsh-mobile-control__diagnostic-details>summary{box-sizing:border-box;min-height:44px;line-height:44px}.dsh-mobile-control__diagnostic-report{box-sizing:border-box;max-height:220px;margin:4px 0 0;overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-secondary,#606873);font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-mobile-control__diagnostic-checks{transition:opacity 150ms ease}.dsh-mobile-control__diagnostic-checks.is-refreshing{opacity:.52}
@keyframes dsh-diagnostic-spin{to{transform:rotate(360deg)}}@keyframes dsh-diagnostic-reveal{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.dsh-mobile-control__actions{display:flex;flex-wrap:nowrap;gap:6px}.dsh-mobile-control__actions[hidden],.dsh-mobile-control__manage-row[hidden]{display:none}.dsh-mobile-control__actions button{flex:1 1 0;min-width:0;min-height:44px;padding:8px 4px;border-radius:10px;font:12px/1.2 system-ui;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-mobile-control__secondary{border:1px solid var(--dsw-alias-border-l3,#cfd5dd);background:transparent;color:inherit}.dsh-mobile-control__primary{border:1px solid #2563eb;background:#2563eb;color:#fff}.dsh-mobile-control__actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control button:focus-visible,.dsh-mobile-control a:focus-visible,.dsh-mobile-control input:focus-visible,.dsh-mobile-control select:focus-visible,.dsh-mobile-control summary:focus-visible{outline:3px solid rgb(37 99 235 / 28%);outline-offset:2px}
/* 42px matches the DSH sidebar footer row; it is not one of the panel target tiers. */
.dsh-mobile-control__trigger{box-sizing:border-box;flex:1 1 auto;display:flex;align-items:center;gap:8px;width:100%;height:42px;margin:4px 0;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#16181d);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;overflow:hidden}.dsh-mobile-control__trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.dsh-mobile-control__trigger:active,.dsh-mobile-control__trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active,#e8ebf0)}.dsh-mobile-control__trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px}.dsh-mobile-control__trigger.is-rail{flex:0 0 auto;width:36px;height:36px;margin:8px 0 10px;padding:0;justify-content:center;gap:0;border-radius:50%}.dsh-mobile-control__trigger-icon{display:block;flex:none}.dsh-mobile-control__trigger-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-mobile-control__manage-row{display:flex;justify-content:space-between;gap:8px;margin-top:10px}.dsh-mobile-control__manage{flex:1 1 0;min-width:0;min-height:36px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:transparent;color:inherit;font:12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__devices{margin-top:10px;border:1px solid var(--dsw-alias-border-l2,#e1e5eb);border-radius:10px;padding:8px;max-height:220px;overflow-y:auto}.dsh-mobile-control__device-empty{color:var(--dsw-alias-label-secondary,#606873);font-size:12px;margin:0}.dsh-mobile-control__device{display:flex;align-items:center;gap:8px;padding:6px 2px}.dsh-mobile-control__device + .dsh-mobile-control__device{border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__device-label{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.dsh-mobile-control__device-meta{flex:none;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;white-space:nowrap}.dsh-mobile-control__device-revoke{flex:none;min-height:36px;padding:4px 8px;border:1px solid var(--dsw-alias-state-error-primary,#dc2626);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#dc2626);font:12px/1.2 system-ui;cursor:pointer}.dsh-mobile-control__ws-paths{margin:10px 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__ws-paths-list{margin:0 0 8px;padding:0;list-style:none}.dsh-mobile-control__ws-paths-empty{color:var(--dsw-alias-label-secondary,#606873);font-size:12px}.dsh-mobile-control__ws-paths-item{display:flex;align-items:center;gap:8px;padding:6px 0}.dsh-mobile-control__ws-paths-item + .dsh-mobile-control__ws-paths-item{border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__ws-paths-item code{flex:1 1 0;min-width:0;overflow:hidden;font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__ws-paths-remove{flex:none;min-height:36px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:8px;background:transparent;color:inherit;font:12px/1.2 system-ui;cursor:pointer}.dsh-mobile-control__trigger,.dsh-mobile-control__diagnostic-entry{position:relative}.dsh-mobile-control__ws-dot{position:absolute;top:2px;right:2px;z-index:1;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;font:650 11px/16px system-ui;text-align:center;cursor:pointer}.dsh-mobile-control__ws-dot::after{content:'';position:absolute;inset:-5px}.dsh-mobile-control__ws-sr-status{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.dsh-mobile-control__ws-paths-row{display:flex;gap:8px}.dsh-mobile-control__ws-paths-row .dsh-mobile-control__primary{width:auto;flex:none;padding:9px 14px;border-radius:10px}.dsh-mobile-control__ws-paths-group{padding:6px 0}.dsh-mobile-control__ws-paths-group + .dsh-mobile-control__ws-paths-group{border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__ws-paths-group-head{display:flex;align-items:center;gap:8px}.dsh-mobile-control__ws-count{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,#e8f0ff);color:var(--dsw-alias-label-primary,#1d4ed8);font:650 11px/1.6 system-ui}.dsh-mobile-control__ws-paths-item.is-child{padding-left:12px}.dsh-mobile-control__ws-paths-group-head .dsh-mobile-control__primary,.dsh-mobile-control__ws-paths-item .dsh-mobile-control__primary{width:auto;flex:none;min-height:36px;padding:6px 12px;border-radius:10px}.dsh-mobile-control__ws-paths-row input{flex:1 1 0;min-width:0;box-sizing:border-box;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:16px/1.4 system-ui}.dsh-mobile-control__ws-paths-row button{flex:none}.dsh-mobile-control__ws-paths-detected-title{margin:0 0 2px;font:600 12px/1.4 system-ui}.dsh-mobile-control__ws-paths-advanced{margin-top:8px}.dsh-mobile-control__ws-paths-advanced summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#606873);font:12px/1.4 system-ui;user-select:none}.dsh-mobile-control__ws-paths-advanced summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px;border-radius:4px}.dsh-mobile-control__ws-paths-advanced[open] summary{margin-bottom:6px}.dsh-mobile-control__ws-paths-advanced .dsh-mobile-control__status{margin:6px 0 0}
@media (max-width:359px){.dsh-mobile-control__provider{min-height:68px}}@media(min-width:600px){.dsh-mobile-control__provider-choices{grid-template-columns:1fr 1fr}.dsh-mobile-control__provider{min-height:88px}}@media (prefers-reduced-motion:reduce){.dsh-mobile-control__provider,.dsh-mobile-control__cpolar-connect{transition:none}.dsh-mobile-control__backdrop,.dsh-mobile-control__panel{animation:none}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-checks{animation:none}}

.dsh-mobile-control__origin-warning{margin:12px 0;padding:10px 12px;border-left:3px solid var(--dsw-alias-state-warn-primary,#a56810);border-radius:4px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-primary,#384152);font-size:12px;line-height:1.6}
` + EXTENSION_RECOVERY_STYLES

/** Mount the desktop control or mobile feature enhancements. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    if (window.__DSH_MOBILE_FRONTEND__ !== 'dedicated') return
    return trustAuthenticatedGatewayConnection(ctx.get('connection'))
  }, 'dsh-mobile: authenticated gateway client trust')

  ctx.effect(() => {
    const desktopAdmin = isDesktopAdminSurface(location.hostname, location.search, window.__DSH_MOBILE_FRONTEND__, location.protocol)
    const style = element('style'); style.dataset.plugin = 'dsh-mobile'; style.textContent = desktopAdmin
      ? CONTROL_STYLES
      : NATIVE_MOBILE_STYLES
    style.textContent += CLIENT_MODULE_STYLES
    document.head.append(style)
    const removeVoiceSession = installVoiceSession(!desktopAdmin)
    const removeModuleSettings = ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item', id: 'dsh-mobile-client-modules', order: 120,
    }, () => createElement(ClientModuleSettingsRow, { scope: desktopAdmin ? 'computer' : 'device', locale: selectedMobileControlLocale() })))
    if (!desktopAdmin) {
      const localFont = installMobileFontPreference()
      const removeSettingsAction = ctx.slots.inject('settings.general.item', () => {
        const removeFontSize = ctx.slots.register({
          name: 'settings.general.item', id: 'font-size', order: 11, priority: -1,
        }, () => createElement(MobileFontSizeRow, { preference: localFont.preference, locale: selectedMobileControlLocale() }))
        const removeDisplayScale = ctx.slots.register({
          name: 'settings.general.item', id: 'dsh-mobile-display-scale', order: 12,
        }, () => createElement(MobileDisplayScaleRow, { locale: selectedMobileControlLocale() }))
        const removeSwitchComputer = ctx.slots.register({
          name: 'settings.general.item',
          id: 'dsh-mobile-switch-computer',
          order: 100,
        }, MobileSwitchComputerRow)
        const removeTaskNotifications = ctx.slots.register({
          name: 'settings.general.item',
          id: 'dsh-mobile-task-notifications',
          order: 110,
        }, MobileTaskNotificationRow)
        return () => { removeTaskNotifications(); removeSwitchComputer(); removeDisplayScale(); removeFontSize() }
      })
      const removeCustom = installCustomAssets()
      const removeSurface = installDshLanguageBoundSurface(() => installNativeMobileSurface({
        getLayout: () => ctx.get('layout'),
        getSidebarRight: () => ctx.get('sidebarRight'),
      }))
      return () => { disposeClientModuleDialogs(); removeModuleSettings(); removeSettingsAction(); removeCustom(); removeSurface(); removeVoiceSession(); localFont.dispose(); style.remove() }
    }
    const removeControl = installDshLanguageBoundSurface(() => {
      const control = installControl()
      const triggerLocale = selectedMobileControlLocale()
      const t = controlTranslator(triggerLocale)
      const disposeSlot = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register<{ wide: boolean }>({ name: 'sidebar.footer.action', id: 'dsh-mobile' }, ({ wide }) => createElement('button', {
        'aria-expanded': control.isOpen(),
        'aria-controls': CONTROL_PANEL_ID,
        'aria-label': t('mobileAccess'),
        className: `dsh-mobile-control__trigger${wide ? '' : ' is-rail'}`,
        lang: triggerLocale,
        type: 'button',
        title: t('mobileAccess'),
        onClick: control.toggle,
      }, createElement('svg', {
        'aria-hidden': true,
        className: 'dsh-mobile-control__trigger-icon',
        focusable: false,
        width: wide ? 16 : 18,
        height: wide ? 16 : 18,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }, createElement('rect', { x: 4, y: 1, width: 8, height: 14, rx: 2 }), createElement('path', { d: 'M7 12h2' })), wide ? createElement('span', { className: 'dsh-mobile-control__trigger-label' }, t('mobileAccess')) : undefined)))
      return () => { disposeSlot(); control.remove() }
    })
    return () => { disposeClientModuleDialogs(); removeModuleSettings(); removeControl(); removeVoiceSession(); style.remove() }
  }, 'dsh-mobile: stock mobile adaptation and local control')
}

/** Client services required by the mobile adaptation. */
export const inject: readonly string[] = ['slots']
