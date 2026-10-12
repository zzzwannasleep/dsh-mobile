/**
 * Authenticated LAN gateway for the existing DSH Web application. The ordinary
 * Web listener remains loopback-only; this package owns pairing and the only
 * listener intended for phones.
 */
export { AccessController, AccessError, BoundedRateLimiter } from './access.js'
export type {
  AccessControllerOptions,
  DeviceProbeResult,
  DeviceSummary,
  PairingResult,
  RenewalResult,
  SessionAuthorization,
  SessionEndReason,
} from './access.js'
export { Config, parseControlFile, parseGatewayConfig } from './config.js'
export { resolveHostExecution } from './extension-worker-config.js'
export type { HostExecutionConfig, ResolvedHostExecutionConfig } from './extension-worker-config.js'
export { ClientModulePreferenceStore } from './client-module-preferences.js'
export type { ClientModuleEntry, ClientModulePreferenceView, ClientModulePreferenceSelection } from './client-module-preferences.js'
export type {
  DisabledTlsConfig,
  PluginConfig,
  ProvidedTlsConfig,
  ResolvedGatewayConfig,
  TlsConfig,
} from './config.js'
export {
  JsonMobileAccessControlStore,
  MobileAccessGatewayController,
  parseMobileAccessControlState,
} from './control.js'
export type {
  MobileAccessControlState,
  MobileAccessControlStore,
  MobileAccessRuntime,
} from './control.js'
export { ClientModuleConflictError, MobileAccessGateway, rewriteMobileIndex } from './gateway.js'
export {
  EXTENSION_LIMITS,
  MobileAccessService,
  MobileExtensionError,
  assertExtensionId,
  createMobileAccessService,
  parseExtensionManifest,
} from './extensions.js'
export type {
  LocalExtensionManifest,
  MobileAccessService as MobileAccessRegistry,
  MobileActionContext,
  MobileExtensionClientEntry,
  MobileExtensionDefinition,
  MobileExtensionManifest,
  MobileExtensionStatus,
  MobileHostAction,
  MobileHostRoute,
  MobileWorkerHostApi,
  MobileRouteRequest,
  MobileRouteResponse,
} from './extensions.js'
export {
  AUTH_PREFIX,
  CSRF_COOKIE,
  CSRF_HEADER,
  DEVICE_COOKIE,
  LOCAL_ADMIN_PREFIX,
  SESSION_COOKIE,
  WS_PATHS,
} from './http-security.js'
export {
  addressAllowed,
  isGloballyRoutableIpv4,
  isLoopbackAddress,
  parseAuthority,
  parseCidr,
  RequestTrustPolicy,
  resolveAuthority,
} from './network.js'
export type { AuthoritySpec, ParsedCidr } from './network.js'
export {
  JsonDeviceStore,
  MemoryDeviceStore,
  parseDeviceSnapshot,
} from './storage.js'
export type { DeviceSnapshot, DeviceStore, StoredDevice } from './storage.js'
export { FrpComponentManager, FRP_COMPONENT_RELEASES } from './frp-component.js'
export type { FrpComponentStatus } from './frp-component.js'
export {
  BlockedUpgradePathLog,
  MAX_BLOCKED_UPGRADE_PATHS,
  MAX_EXTRA_WEBSOCKET_PATHS,
  MAX_WEBSOCKET_PATH_LENGTH,
  normalizeWebSocketPaths,
  validateWebSocketPath,
  WebSocketPathStore,
} from './websocket-paths.js'
export type { BlockedUpgradePathEntry } from './websocket-paths.js'
export { CloudflaredComponentManager, CLOUDFLARED_COMPONENT_RELEASE, CLOUDFLARED_COMPONENT_RELEASES } from './cloudflared-component.js'
export type { CloudflaredComponentStatus } from './cloudflared-component.js'
export { CloudflaredController, isCloudflaredRegistration } from './cloudflared.js'
export type { CloudflaredControllerOptions, CloudflaredState, CloudflaredStatus } from './cloudflared.js'
export {
  CloudflaredTunnelStore,
  mergeSavedCloudflaredTunnelSettings,
  parseCloudflaredTunnelSettings,
  validateCloudflaredTunnelHostname,
  validateCloudflaredTunnelPort,
  validateCloudflaredTunnelToken,
} from './cloudflared-tunnel.js'
export type { CloudflaredTunnelSettings, CloudflaredTunnelStatus } from './cloudflared-tunnel.js'
export {
  ensureTlsIngressCertificate,
  purgeTlsIngressCertificates,
  tlsIngressPaths,
} from './tls-ingress.js'
export type { TlsIngressCertificate, TlsIngressPaths, TlsIngressSettings } from './tls-ingress.js'
export {
  SakuraFrpController,
  SakuraFrpSettingsStore,
  SAKURAFRP_API_BASE,
  SAKURAFRP_FRPC_VERSION,
  SAKURAFRP_LOGIN_URL,
  createSakuraFrpApiClient,
  deriveSakuraFrpEntry,
  isSakuraFrpRegistration,
  parseSakuraFrpExportAddress,
  parseSakuraFrpTunnels,
  validateSakuraFrpToken,
  validateSakuraFrpTunnelId,
} from './sakurafrp.js'
export type {
  SakuraFrpApiClient,
  SakuraFrpConfiguration,
  SakuraFrpControllerOptions,
  SakuraFrpSettings,
  SakuraFrpState,
  SakuraFrpStatus,
  SakuraFrpTunnel,
} from './sakurafrp.js'

export { CERT_EXPIRING_DAYS, evaluateCertificateLifetime, probeOriginCertificate, readCertificateRenewal } from './cert-renewal.js'
export type { CertRenewalStatus } from './cert-renewal.js'
export { issueServerCertificate } from './managed-setup.js'
export type { ServerCertificateAuthority, ServerCertificateFiles, ServerCertificateTarget } from './managed-setup.js'
export { configuredRemoteProvider, JsonRemoteProviderStore, parseRemoteProviderState, REMOTE_PROVIDERS } from './remote.js'
export type {
  RemoteProvider,
  RemoteProviderController,
  RemoteProviderState,
  RemoteProviderStatus,
} from './remote.js'
export {
  TASK_EVENT_DEBOUNCE_MS,
  TaskEventHub,
  watchTaskCompletions,
} from './task-events.js'
export type {
  TaskCompletionEvent,
  TaskEventContext,
  TaskEventSession,
  TaskEventSink,
  TaskEventWatcherOptions,
  TaskTurnEvent,
} from './task-events.js'
export { apply, inject, name, remoteGatewayConfig, tlsIngressGatewayConfig } from './plugin.js'