export type MobileControlLocale = 'it' | 'en' | 'zh'

const storageMessages = {
  en: { componentPathUnsafe: 'The component folder contains an unsafe link or cannot be accessed. Check the directory and permissions, then retry.' },
  zh: { componentPathUnsafe: '组件目录包含不安全的链接或无法访问。请检查目录和权限后重试。' },
  it: { componentPathUnsafe: 'La cartella del componente contiene un collegamento non sicuro o non è accessibile. Controlla directory e permessi, poi riprova.' },
}

/** Desktop-only stopped-worker recovery, independent of remote provider state. */
export const EXTENSION_RECOVERY_MESSAGES = {
  en: {
    extensionRecoveryTitle: 'An extension needs a restart', extensionRecoveryHelp: 'Only the stopped extension restarts. Unfinished actions are not retried.',
    extensionRecoveryRestart: 'Restart', extensionRecoveryRestarting: 'Restarting…', extensionRecoveryRestartAria: 'Restart extension {name}',
    extensionRecoveryConfirm: 'Restart extension “{name}”? Unfinished actions will not be retried. Previously completed changes will not be undone.',
    extensionRecoveryRefresh: 'Check again', extensionRecoveryLoadFailed: 'Could not check the extension status. Check again before restarting.',
    extensionRecoveryFailed: 'The extension did not restart. Check its configuration, then retry.', extensionRecoveryChanged: 'The extension files changed. Review the changes and reload the extension before trying again.',
  },
  it: {
    extensionRecoveryTitle: 'Un’estensione richiede un riavvio', extensionRecoveryHelp: 'Si riavvia solo l’estensione arrestata. Le azioni incompiute non vengono ripetute.',
    extensionRecoveryRestart: 'Riavvia', extensionRecoveryRestarting: 'Riavvio…', extensionRecoveryRestartAria: 'Riavvia l’estensione {name}',
    extensionRecoveryConfirm: 'Riavviare l’estensione “{name}”? Le azioni incompiute non verranno ripetute. Le modifiche già completate non saranno annullate.',
    extensionRecoveryRefresh: 'Controlla di nuovo', extensionRecoveryLoadFailed: 'Impossibile verificare lo stato. Controlla di nuovo prima di riavviare.',
    extensionRecoveryFailed: 'L’estensione non si è riavviata. Controlla la configurazione e riprova.', extensionRecoveryChanged: 'I file dell’estensione sono cambiati. Verifica le modifiche e ricarica l’estensione prima di riprovare.',
  },
  zh: {
    extensionRecoveryTitle: '扩展需要重启', extensionRecoveryHelp: '仅重启已停止的扩展，不会重新执行未完成的操作。',
    extensionRecoveryRestart: '重启扩展', extensionRecoveryRestarting: '正在重启…', extensionRecoveryRestartAria: '重启扩展 {name}',
    extensionRecoveryConfirm: '要重启扩展“{name}”吗？未完成的操作不会重新执行，已经完成的修改也不会撤销。',
    extensionRecoveryRefresh: '重新检测', extensionRecoveryLoadFailed: '暂时无法检查扩展状态，请重新检测后再操作。',
    extensionRecoveryFailed: '扩展没有重启成功，请检查配置后重试。', extensionRecoveryChanged: '扩展文件已经变化，请核对修改并重新加载扩展后再操作。',
  },
} satisfies Record<MobileControlLocale, Record<string, string>>

export const MOBILE_CONTROL_MESSAGES = {
  en: {
    mobileAccess: 'Mobile access', collapseMobileAccess: 'Collapse Mobile access', downloadAndroid: 'Download latest Android app', downloadAndroidVersion: 'Download latest Android app · v{version}', downloadAndroidAria: 'Download the latest Android app from GitHub Releases', downloadAndroidVersionAria: 'Download Android app v{version} from GitHub Releases', updatePlugin: 'Update plugin', updatePluginAria: 'Update DSH Mobile to v{version}', updatingPlugin: 'Updating…', pluginUpdatedRestart: 'Updated to v{version}. Restart DSH to apply it.', pluginUpdateFailed: 'Update failed: {error}', updateTo: 'Update to v{version}', updateNotice: 'Restart DSH after installing. Existing apps and paired devices need no re-pairing; unsure about the desktop version? Check the README compatibility table.', updateNotesEmpty: 'No release notes fetched — updating is still fine; full details on the GitHub Release page.', updateNow: 'Update now', updateLater: 'Not now',
    lan: 'Local network', remote: 'Remote', lanAccess: 'Local network access', remoteAccess: 'Remote access', browserAccess: 'Browser access', remoteAddress: 'Remote address', loadingStatus: 'Loading status…', loadingRemoteStatus: 'Loading remote status…',
    generateCopyKey: 'Generate and copy key', copyPairLink: 'Copy pairing link', managePairedDevices: 'Manage paired devices', clearAllDevices: 'Clear all devices', pairingQr: 'Pairing QR code',
    remoteIntro: 'Choose the remote channel that suits you. Switching or disabling remote access does not affect the local network.', httpFrameWarning: 'HTTP pages may be embedded for compatibility, but their contents are unencrypted and can be altered. Use HTTPS for sensitive work.', chooseProvider: 'Choose connection method', currentProvider: 'Current connection', remoteStateOff: 'Off', remoteStateConnecting: 'Connecting', remoteStateAttention: 'Needs attention', providerInfoAria: 'View remote connection security and network information', providerGroupAria: 'Remote connection method', providerSafeTitle: 'You remain protected', providerSafeText: 'Only paired devices can reach DSH; components install on demand and can be removed completely.',
    mainlandPreferred: 'Preferred in mainland China', sakuraDescription: 'Builds the remote channel over a SakuraFrp (natfrp.com) TCP tunnel; works on mainland China networks and needs an access key from the SakuraFrp panel.',
    prepareSakurafrp: 'Prepare SakuraFrp', checkingComponent: 'Checking component…', installOfficial: 'Install official component', installFrpc: 'Install official frpc', sakuraTokenNote: 'Needs an access key from natfrp.com (User panel → Access key). TCP tunnels only; the local target can stay empty — the plugin points it at the gateway port.', sakuraPanelLink: 'Open the SakuraFrp user panel', tokenPlaceholder: 'Paste the SakuraFrp access key', saveToken: 'Save key and connect', saving: 'Saving…', componentDetails: 'Component source and cleanup', componentDetailsText: 'frpc 0.70.1 is downloaded from the official frp release only after you choose Install; no service, PATH entry, or startup item.', pluginPrivateDirectory: 'Plugin private directory', officialDownload: 'Official download page', terms: 'Terms of service',
    enableRemote: 'Enable remote access', disableRemote: 'Disable remote access', reconnect: 'Reconnect', generateRemoteQr: 'Generate remote pairing QR code', copyRemoteLink: 'Copy remote pairing link', manageRemoteDevices: 'Manage remote devices', resetRemoteDevices: 'Disable and clear remote devices',
    lanOn: 'Local network access is on.', lanOff: 'Local network access is off.', enableLan: 'Enable local network access', disableLan: 'Disable local network access', extensionsLoaded: 'Extensions: {loaded} loaded', extensionsFailed: 'Extensions: {loaded} loaded, {failed} failed',
    keyGenerationFailed: 'Could not generate a pairing key.', keyCopied: 'Pairing key copied. Paste it into the Android app.', linkCopied: 'Pairing link copied. Send it to the phone and paste it into the app or open it in a browser.', copySecret: 'Copy {kind}: {value}', pairingKey: 'pairing key', pairingLink: 'pairing link', noDevices: 'No paired devices.', noRemoteDevices: 'No remote paired devices.', device: 'Device', expires: 'Expires {time}', revoke: 'Revoke', confirmResetDevices: 'Remove all paired devices? Connected devices will be disconnected immediately.',
    ready: 'Ready', installed: 'Installed', installWithSize: 'Install official component · {size} MB',
    remoteOff: 'Remote access is disabled. Local network access is unaffected.', remoteUnavailableCloudflared: 'cloudflared is not installed.', remoteUnavailableSakura: 'SakuraFrp is not installed or the access key is not configured.', remoteStartingCloudflared: 'Starting the cloudflared connector…', remoteStartingSakura: 'Starting the SakuraFrp channel…', remoteConnectingCloudflared: 'Starting the DSH authentication gateway…', remoteConnectingSakura: 'Tunnel connected; starting the DSH authentication gateway…', remoteReady: 'Remote access is ready. Only paired devices can access DSH.', remoteError: 'The remote connection was not established. Reconnect; local network access still works.',
    gatewayStartFailed: 'The remote gateway failed to start. Reconnect; local network access is unaffected.', controlChannelFailed: 'The remote component connection was interrupted. Reconnect.',
    switchProviderConfirm: 'Switching connection method first disables the current remote channel. Local network access and paired devices are unaffected. Continue?', switchingCloudflared: 'Switching to cloudflared…', switchingSakura: 'Switching to SakuraFrp…', downloading: 'Downloading and verifying…', installFailed: 'Component installation failed: {error}', configureFailed: 'Configuration failed: {error}', purgeFailed: 'Cleanup failed: {error}', reconnectingCloudflared: 'Reconnecting cloudflared…', reconnectingSakura: 'Reconnecting SakuraFrp…', remoteQrReady: 'Remote pairing QR code generated. Scan it from “Remote access” in the app.', resetCloudflaredConfirm: 'Disable the cloudflared remote channel and remove all remote paired devices? The installed component and the local network configuration are unchanged.', resetSakuraConfirm: 'Disable the SakuraFrp remote channel and remove all remote paired devices? The access key and the selected tunnel are unchanged.', requestFailed: 'Request failed: {error}', wsPathsTitle: 'Third-party WebSocket paths', wsPathsIntro: 'If a plugin cannot connect, its path is not approved yet — one click on “Allow” fixes each item below.', wsPathsPlaceholder: '/sidebar/ws/terminal', wsPathsAdd: 'Allow path', wsPathsRemove: 'Remove', wsPathsEmpty: 'Nothing to configure right now. If a plugin cannot connect later, one-click options appear here.', wsPathsInvalid: 'Enter an exact path starting with / (no query string).', wsPathsDetected: 'A plugin connection was blocked — press Allow to let it through', wsPathsAllow: 'Allow', wsPathsAllowAll: 'Allow all', wsPathsGroupMeta: '{n} paths · blocked {m} times', wsPathsNewBlocked: 'New blocked third-party connections — open diagnostics to review', wsPathsAdvancedToggle: 'Add paths manually (advanced)', wsPathsAnnounce: '{n} plugin connections waiting to be approved', wsPathsAdvancedHint: 'Manual entries are rarely necessary: use the buttons above. Only fill this in when you know the exact path.',
  },
  it: {
    mobileAccess: 'Accesso mobile', collapseMobileAccess: 'Riduci Accesso mobile', downloadAndroid: 'Scarica l’ultima app Android', downloadAndroidVersion: 'Scarica l’ultima app Android · v{version}', downloadAndroidAria: 'Scarica l’ultima app Android da GitHub Releases', downloadAndroidVersionAria: 'Scarica l’app Android v{version} da GitHub Releases', updatePlugin: 'Aggiorna plugin', updatePluginAria: 'Aggiorna DSH Mobile alla v{version}', updatingPlugin: 'Aggiornamento…', pluginUpdatedRestart: 'Aggiornato alla v{version}. Riavvia DSH per applicarlo.', pluginUpdateFailed: 'Aggiornamento non riuscito: {error}', updateTo: 'Aggiorna alla v{version}', updateNotice: 'Riavvia DSH dopo l’installazione. Le app esistenti e i dispositivi già associati non richiedono ri-associazione; in caso di dubbi sulla versione desktop, consulta la tabella di compatibilità nel README.', updateNotesEmpty: 'Note di rilascio non recuperate — l’aggiornamento resta possibile; dettagli nella pagina Release su GitHub.', updateNow: 'Aggiorna ora', updateLater: 'Non ora',
    lan: 'Rete locale', remote: 'Remoto', lanAccess: 'Accesso rete locale', remoteAccess: 'Accesso remoto', browserAccess: 'Accesso browser', remoteAddress: 'Indirizzo remoto', loadingStatus: 'Lettura stato…', loadingRemoteStatus: 'Lettura stato remoto…',
    generateCopyKey: 'Genera e copia chiave', copyPairLink: 'Copia link di abbinamento', managePairedDevices: 'Gestisci dispositivi abbinati', clearAllDevices: 'Rimuovi tutti i dispositivi', pairingQr: 'Codice QR di abbinamento', remoteIntro: 'Scegli il canale remoto più adatto. Cambiare o disattivare l’accesso remoto non influisce sulla rete locale.', httpFrameWarning: 'Le pagine HTTP possono essere incorporate per compatibilità, ma i contenuti non sono cifrati e possono essere alterati. Usa HTTPS per le attività sensibili.', chooseProvider: 'Scegli metodo di connessione', currentProvider: 'Connessione attuale', remoteStateOff: 'Disattivata', remoteStateConnecting: 'Connessione', remoteStateAttention: 'Da controllare', providerInfoAria: 'Informazioni su sicurezza e rete della connessione remota', providerGroupAria: 'Metodo di connessione remota', providerSafeTitle: 'La protezione resta attiva', providerSafeText: 'Solo i dispositivi abbinati raggiungono DSH; i componenti si installano su richiesta e si rimuovono del tutto.',
    mainlandPreferred: 'Preferito in Cina continentale', sakuraDescription: 'Crea il canale remoto tramite un tunnel TCP SakuraFrp (natfrp.com); funziona sulle reti della Cina continentale e richiede una chiave di accesso dal pannello SakuraFrp.',
    prepareSakurafrp: 'Prepara SakuraFrp', checkingComponent: 'Controllo componente…', installOfficial: 'Installa componente ufficiale', installFrpc: 'Installa frpc ufficiale', sakuraTokenNote: 'Serve la chiave di accesso da natfrp.com (Pannello utente → Chiave di accesso). Solo tunnel TCP; la destinazione locale può restare vuota: il plugin la imposta sulla porta del gateway.', sakuraPanelLink: 'Apri il pannello utente SakuraFrp', tokenPlaceholder: 'Incolla la chiave di accesso SakuraFrp', saveToken: 'Salva chiave e connetti', saving: 'Salvataggio…', componentDetails: 'Origine e rimozione del componente', componentDetailsText: 'frpc 0.70.1 viene scaricato dalla release ufficiale di frp solo dopo aver scelto Installa; nessun servizio, PATH o avvio automatico.', pluginPrivateDirectory: 'Directory privata del plugin', officialDownload: 'Pagina download ufficiale', terms: 'Termini di servizio',
    enableRemote: 'Attiva accesso remoto', disableRemote: 'Disattiva accesso remoto', reconnect: 'Riconnetti', generateRemoteQr: 'Genera QR di abbinamento remoto', copyRemoteLink: 'Copia link di abbinamento remoto', manageRemoteDevices: 'Gestisci dispositivi remoti', resetRemoteDevices: 'Disattiva e rimuovi dispositivi remoti',
    lanOn: 'Accesso dalla rete locale attivo.', lanOff: 'Accesso dalla rete locale disattivato.', enableLan: 'Attiva accesso rete locale', disableLan: 'Disattiva accesso rete locale', extensionsLoaded: 'Estensioni: {loaded} caricate', extensionsFailed: 'Estensioni: {loaded} caricate, {failed} non riuscite',
    keyGenerationFailed: 'Impossibile generare la chiave di abbinamento.', keyCopied: 'Chiave di abbinamento copiata. Incollala nell’app Android.', linkCopied: 'Link di abbinamento copiato. Invialo al telefono e incollalo nell’app oppure aprilo nel browser.', copySecret: 'Copia {kind}: {value}', pairingKey: 'chiave di abbinamento', pairingLink: 'link di abbinamento', noDevices: 'Nessun dispositivo abbinato.', noRemoteDevices: 'Nessun dispositivo remoto abbinato.', device: 'Dispositivo', expires: 'Scade {time}', revoke: 'Revoca', confirmResetDevices: 'Rimuovere tutti i dispositivi abbinati? I dispositivi connessi verranno disconnessi subito.',
    ready: 'Pronto', installed: 'Installato', installWithSize: 'Installa componente ufficiale · {size} MB',
    remoteOff: 'Accesso remoto disattivato. La rete locale non è interessata.', remoteUnavailableCloudflared: 'cloudflared non è installato.', remoteUnavailableSakura: 'SakuraFrp non è installato o la chiave di accesso non è configurata.', remoteStartingCloudflared: 'Avvio del connettore cloudflared…', remoteStartingSakura: 'Avvio del canale SakuraFrp…', remoteConnectingCloudflared: 'Avvio del gateway di autenticazione DSH…', remoteConnectingSakura: 'Tunnel connesso; avvio del gateway di autenticazione DSH…', remoteReady: 'Accesso remoto pronto. Solo i dispositivi abbinati possono accedere a DSH.', remoteError: 'Connessione remota non stabilita. Riconnettiti; la rete locale continua a funzionare.',
    gatewayStartFailed: 'Avvio del gateway remoto non riuscito. Riconnettiti; la rete locale non è interessata.', controlChannelFailed: 'Connessione al componente remoto interrotta. Riconnettiti.',
    switchProviderConfirm: 'Il cambio di metodo disattiva prima il canale remoto corrente. Rete locale e dispositivi abbinati non sono interessati. Continuare?', switchingCloudflared: 'Passaggio a cloudflared…', switchingSakura: 'Passaggio a SakuraFrp…', downloading: 'Download e verifica…', installFailed: 'Installazione componente non riuscita: {error}', configureFailed: 'Configurazione non riuscita: {error}', purgeFailed: 'Pulizia non riuscita: {error}', reconnectingCloudflared: 'Riconnessione di cloudflared…', reconnectingSakura: 'Riconnessione di SakuraFrp…', remoteQrReady: 'QR di abbinamento remoto generato. Scansionalo da “Accesso remoto” nell’app.', resetCloudflaredConfirm: 'Disattivare il canale remoto cloudflared e rimuovere tutti i dispositivi remoti? Il componente installato e la configurazione della rete locale restano invariati.', resetSakuraConfirm: 'Disattivare il canale remoto SakuraFrp e rimuovere tutti i dispositivi remoti? Chiave di accesso e tunnel selezionato restano invariati.', requestFailed: 'Richiesta non riuscita: {error}', wsPathsTitle: 'Percorsi WebSocket di terze parti', wsPathsIntro: 'Se un plugin non si connette, il suo percorso non è ancora approvato: un clic su “Consenti” risolve ogni voce qui sotto.', wsPathsPlaceholder: '/sidebar/ws/terminal', wsPathsAdd: 'Consenti percorso', wsPathsRemove: 'Rimuovi', wsPathsEmpty: 'Non serve configurare nulla per ora. Se in seguito un plugin non riesce a connettersi, qui compariranno opzioni con un clic.', wsPathsInvalid: 'Inserisci un percorso esatto che inizi con / (senza query).', wsPathsDetected: 'Una connessione di un plugin è stata bloccata — premi Consenti per lasciarla passare', wsPathsAllow: 'Consenti', wsPathsAllowAll: 'Consenti tutti', wsPathsGroupMeta: '{n} percorsi · bloccati {m} volte', wsPathsNewBlocked: 'Nuove connessioni di terze parti bloccate — apri la diagnostica', wsPathsAdvancedToggle: 'Aggiungi percorsi manualmente (avanzato)', wsPathsAnnounce: '{n} connessioni di plugin in attesa di approvazione', wsPathsAdvancedHint: 'Le voci manuali servono raramente: usa i pulsanti qui sopra. Compila solo se conosci il percorso esatto.',
  },
  zh: {} as Record<string, string>,
} satisfies Record<MobileControlLocale, Record<string, string>>

for (const locale of ['en', 'it', 'zh'] as const) Object.assign(MOBILE_CONTROL_MESSAGES[locale], EXTENSION_RECOVERY_MESSAGES[locale])

for (const locale of ['en', 'it', 'zh'] as const) Object.assign(MOBILE_CONTROL_MESSAGES[locale], storageMessages[locale])

Object.assign(MOBILE_CONTROL_MESSAGES.zh, {
  mobileAccess: '移动访问', collapseMobileAccess: '收起移动访问', downloadAndroid: '下载最新 Android App', downloadAndroidVersion: '下载最新 Android App · v{version}', downloadAndroidAria: '从 GitHub Releases 下载最新版 Android App', downloadAndroidVersionAria: '从 GitHub Releases 下载 Android App v{version}', updatePlugin: '更新插件', updatePluginAria: '将 DSH Mobile 更新至 v{version}', updatingPlugin: '正在更新…', pluginUpdatedRestart: '插件已更新至 v{version}，重启 DSH 后生效。', pluginUpdateFailed: '更新失败：{error}', updateTo: '更新到 v{version}', updateNotice: '安装后需重启 DSH。现有 App 与已配对设备无需重新配对；电脑端版本不确定时，先对照 README 兼容表。', updateNotesEmpty: '未取到最新版更新说明，仍可继续更新；详情见 GitHub Release 页。', updateNow: '立即更新', updateLater: '暂不', lan: '局域网', remote: '远程', lanAccess: '局域网访问', remoteAccess: '远程访问', browserAccess: '浏览器访问', remoteAddress: '远程地址', loadingStatus: '正在读取状态…', loadingRemoteStatus: '正在读取远程状态…',
  generateCopyKey: '生成并复制密钥', copyPairLink: '复制配对链接', managePairedDevices: '管理配对设备', clearAllDevices: '清除所有设备', pairingQr: '配对二维码', remoteIntro: '选择更适合你的远程通道。切换或关闭远程访问不会影响局域网。', httpFrameWarning: '为兼容性允许嵌入 HTTP 页面，但内容未加密，可能被篡改；处理敏感内容请使用 HTTPS。', chooseProvider: '选择连接方式', currentProvider: '当前连接', remoteStateOff: '未启用', remoteStateConnecting: '连接中', remoteStateAttention: '需处理', providerInfoAria: '查看远程连接安全与网络说明', providerGroupAria: '远程连接方式', providerSafeTitle: '你始终可以放心', providerSafeText: '只有已配对设备能访问 DSH；组件按需安装，可彻底清理。',
  mainlandPreferred: '国内网络优先', sakuraDescription: '通过 SakuraFrp（樱花内网穿透，natfrp.com）的 TCP 隧道建立远程通道，国内网络可用；需要官网的访问密钥。',
  prepareSakurafrp: '准备 SakuraFrp', checkingComponent: '正在检查组件…', installOfficial: '安装官方组件', installFrpc: '安装官方 frpc', sakuraTokenNote: '需要 natfrp.com「用户面板 → 访问密钥」的访问密钥；仅支持 TCP 隧道，本地目标可留空，插件自动指向网关端口。', sakuraPanelLink: '打开 SakuraFrp 用户面板', tokenPlaceholder: '粘贴 SakuraFrp 访问密钥', saveToken: '保存密钥并连接', saving: '正在保存…', componentDetails: '组件来源与清理说明', componentDetailsText: '仅在你点击安装后才从 frp 官方 Release 下载校验 frpc 0.70.1；不装服务、不写 PATH、无开机启动。', pluginPrivateDirectory: '插件私有目录', officialDownload: '官方下载安装页', terms: '服务条款',
  enableRemote: '启用远程访问', disableRemote: '关闭远程访问', reconnect: '重新连接', generateRemoteQr: '生成远程配对二维码', copyRemoteLink: '复制远程配对链接', manageRemoteDevices: '管理远程设备', resetRemoteDevices: '关闭并清除远程设备', lanOn: '局域网访问已开启。', lanOff: '局域网访问已关闭。', enableLan: '开启局域网访问', disableLan: '关闭局域网访问', extensionsLoaded: '扩展：{loaded} 个已加载', extensionsFailed: '扩展：{loaded} 个已加载，{failed} 个加载失败', keyGenerationFailed: '无法生成配对密钥。', keyCopied: '配对密钥已复制，请粘贴到 Android App。', linkCopied: '配对链接已复制，发给手机后 App 粘贴或浏览器打开即可配对。', copySecret: '请复制{kind}：{value}', pairingKey: '配对密钥', pairingLink: '配对链接', noDevices: '暂无配对设备。', noRemoteDevices: '暂无远程配对设备。', device: '设备', expires: '到期 {time}', revoke: '撤销', confirmResetDevices: '确定要移除所有配对设备吗？此操作会立即终止已连接设备。', ready: '已就绪', installed: '已安装', installWithSize: '安装官方组件 · {size} MB',
  remoteOff: '远程访问未启用。局域网访问不受影响。', remoteUnavailableCloudflared: 'cloudflared 尚未安装。', remoteUnavailableSakura: 'SakuraFrp 组件未安装或未完成访问密钥配置。', remoteStartingCloudflared: '正在启动 cloudflared 连接器…', remoteStartingSakura: '正在通过 SakuraFrp 建立远程通道…', remoteConnectingCloudflared: '正在启动 DSH 认证网关…', remoteConnectingSakura: '隧道已连通，正在启动 DSH 认证网关…', remoteReady: '远程访问已就绪。只有已配对设备可以进入 DSH。', remoteError: '远程连接未建立。可重新连接，局域网访问仍可正常使用。',
  gatewayStartFailed: '远程网关启动失败。请重新连接，局域网访问不受影响。', controlChannelFailed: '远程组件连接中断。请重新连接。',
  switchProviderConfirm: '切换连接方式会先关闭当前远程通道。局域网和配对设备不会受影响，是否继续？', switchingCloudflared: '正在切换到 cloudflared…', switchingSakura: '正在切换到 SakuraFrp…', downloading: '正在下载并校验…', installFailed: '组件安装失败：{error}', configureFailed: '配置失败：{error}', purgeFailed: '清理失败：{error}', reconnectingCloudflared: '正在重连 cloudflared…', reconnectingSakura: '正在重新连接 SakuraFrp…', remoteQrReady: '远程配对二维码已生成。请在 App 的“远程访问”中扫描。', resetCloudflaredConfirm: '关闭 cloudflared 远程通道并移除所有远程配对设备？已安装组件与局域网配置保持不变。', resetSakuraConfirm: '关闭 SakuraFrp 远程通道并移除所有远程配对设备？访问密钥与所选隧道保持不变。', requestFailed: '请求失败：{error}', wsPathsTitle: '第三方 WebSocket 路径', wsPathsIntro: '插件连不上时，通常是它的连接路径未放行；下面每项点「允许」即可。', wsPathsPlaceholder: '/sidebar/ws/terminal', wsPathsAdd: '允许该路径', wsPathsRemove: '移除', wsPathsEmpty: '目前无需任何设置。以后有插件连不上，会在这里出现可一键放行的选项。', wsPathsInvalid: '请输入以 / 开头的确切路径（不带 query）。', wsPathsDetected: '有插件连接被拦截——点「允许」放行', wsPathsAllow: '允许', wsPathsAllowAll: '全部允许', wsPathsGroupMeta: '{n} 条路径 · 共拦截 {m} 次', wsPathsNewBlocked: '发现被拦截的第三方连接，去诊断页查看', wsPathsAdvancedToggle: '手动添加路径（高级）', wsPathsAnnounce: '{n} 条插件连接等待放行', wsPathsAdvancedHint: '通常不需要手动填写：用上方按钮即可。只有当你确切知道所需路径时才填。'
})

Object.assign(MOBILE_CONTROL_MESSAGES.en, {
  trustedNetworksTitle: 'Additional trusted networks · Advanced', trustedNetworksHelp: 'Keep the LAN subnet and explicitly add only networks you control, such as a routed WireGuard subnet. Device pairing and HTTPS are still required. Separate CIDRs with spaces, commas, or newlines.', trustedNetworksLabel: 'Additional source networks', trustedNetworksSave: 'Save networks', trustedNetworksUnavailable: 'Available only with managed LAN setup.', trustedNetworksRestart: 'Saved. Restart DSH to apply; existing connections are not interrupted now.', trustedNetworksWindows: 'On Windows, the firewall must also allow these source networks; the default rule allows LocalSubnet only.', trustedNetworksFailed: 'Could not read this setting. Retry after reopening this section.', trustedNetworksInvalid: 'Could not save. Enter valid network CIDRs, for example 11.24.0.0/24, and check that DSH can write its private setup file.',
  sakuraTokenSaved: 'Saved securely; leave blank to keep it', sakuraTokenLabel: 'Access key', sakuraTokenSavedNow: 'Access key saved; loading your tunnels…', sakuraTunnelsTitle: 'Choose the TCP tunnel', sakuraTunnelsRefresh: 'Load tunnel list', sakuraTunnelSelect: 'Choose the tunnel to use', sakuraTunnelEmpty: 'No tunnel saved yet. Save the access key, then load the tunnel list.', sakuraTunnelConfigured: 'Tunnel {name} (#{id}) is selected; “Save and connect” below establishes the channel.', sakuraTunnelHint: 'The plugin points the tunnel’s local target at the DSH gateway port automatically.', sakuraTunnelOnline: 'online', sakuraTunnelOffline: 'offline', sakuraTunnelBannedPanel: 'A tunnel is banned; resolve it in the SakuraFrp panel.', sakuraConfigureSave: 'Save and connect', sakuraConfigured: 'Tunnel saved; establishing the remote channel…', sakuraInstallConfirm: 'Download and verify official frpc 0.70.1 (about {size} MB) from the official frp release, extracting only frpc into the DSH Mobile private directory? No service, PATH entry, or startup item is added.', sakuraInstallingFrpc: 'Installing the official frpc component. Keep DSH running until it completes.', sakuraFrpcReady: 'Official frpc {version} is installed and verified.', sakuraFrpcMissing: 'frpc is not installed. Nothing is downloaded until you click the button below.', sakuraFrpcInvalid: 'frpc verification failed. Remove it completely and reinstall.', sakuraPurge: 'Completely remove the frpc component and SakuraFrp configuration', sakuraPurgeConfirm: 'Completely remove the frpc component, access key, tunnel configuration, and ingress certificates from the DSH Mobile private directory? Local network access, DSH data, and other system programs are unaffected.', sakuraPurgingFrpc: 'Stopping the channel and removing frpc files managed by DSH Mobile…',
  sakuraTokenMissing: 'No SakuraFrp access key is saved. Complete the preparation steps above.', sakuraTokenInvalid: 'The SakuraFrp access key is invalid. Copy it again from the official panel and save it.', sakuraApiUnreachable: 'Could not reach the SakuraFrp API. Check this computer’s network and retry.', sakuraApiError: 'The SakuraFrp API returned an error. Retry later or check the access key.', sakuraTunnelMissing: 'No tunnel is saved yet. Choose a TCP tunnel and save it first.', sakuraTunnelBanned: 'This tunnel is banned by SakuraFrp. Resolve it in the official panel and retry.', sakuraTunnelTypeUnsupported: 'Only TCP tunnels are supported. Create or choose a TCP tunnel in the SakuraFrp panel.', sakuraTunnelLocked: 'This tunnel is locked by SakuraFrp (for example a paid node) and cannot be edited by the plugin.', sakuraTunnelPortUnavailable: 'Could not allocate a local port for this tunnel. Retry or choose another tunnel.', sakuraEntryUnknown: 'The public entry of this tunnel is unknown. Reload the tunnel list.', sakuraConfigFetchFailed: 'Fetching the SakuraFrp tunnel configuration failed. Reconnect.', sakuraLaunchFailed: 'frpc failed to start.', sakuraStartTimeout: 'Timed out waiting for the SakuraFrp channel. Reconnect.', sakuraStopped: 'The SakuraFrp connection stopped.', sakuraExited: 'The SakuraFrp connection exited unexpectedly. Reconnect.', sakuraInvalidOutput: 'frpc returned an unrecognized status.', sakuraSettingsInvalid: 'The local SakuraFrp settings are invalid. Save the access key or tunnel again.', sakuraPortReservationFailed: 'Could not reserve the DSH gateway port. Retry.', remoteComponentLaunchFailed: 'The remote component failed to start. Reconnect.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.it, {
  trustedNetworksTitle: 'Reti attendibili aggiuntive · Avanzate', trustedNetworksHelp: 'Mantieni la sottorete LAN e aggiungi solo reti che controlli, come una sottorete WireGuard instradata. Abbinamento e HTTPS restano obbligatori. Separa i CIDR con spazi, virgole o righe nuove.', trustedNetworksLabel: 'Reti sorgenti aggiuntive', trustedNetworksSave: 'Salva reti', trustedNetworksUnavailable: 'Disponibile solo con la configurazione LAN gestita.', trustedNetworksRestart: 'Salvato. Riavvia DSH per applicare; le connessioni attuali non vengono interrotte.', trustedNetworksWindows: 'Su Windows anche il firewall deve consentire queste reti sorgenti; la regola predefinita consente solo LocalSubnet.', trustedNetworksFailed: 'Impossibile leggere questa impostazione. Riapri la sezione e riprova.', trustedNetworksInvalid: 'Salvataggio non riuscito. Inserisci CIDR validi, ad esempio 11.24.0.0/24, e verifica che DSH possa scrivere il file privato di configurazione.',
  sakuraTokenSaved: 'Salvata; lascia vuoto per mantenerla', sakuraTokenLabel: 'Chiave di accesso', sakuraTokenSavedNow: 'Chiave di accesso salvata; caricamento dei tunnel…', sakuraTunnelsTitle: 'Scegli il tunnel TCP', sakuraTunnelsRefresh: 'Carica elenco tunnel', sakuraTunnelSelect: 'Scegli il tunnel da usare', sakuraTunnelEmpty: 'Nessun tunnel salvato. Salva la chiave di accesso, poi carica l’elenco dei tunnel.', sakuraTunnelConfigured: 'Tunnel {name} (#{id}) selezionato; “Salva e connetti” qui sotto apre il canale.', sakuraTunnelHint: 'Il plugin imposta automaticamente la destinazione locale del tunnel sulla porta del gateway DSH.', sakuraTunnelOnline: 'online', sakuraTunnelOffline: 'offline', sakuraTunnelBannedPanel: 'Un tunnel è bannato; risolvilo nel pannello SakuraFrp.', sakuraConfigureSave: 'Salva e connetti', sakuraConfigured: 'Tunnel salvato; creazione del canale remoto…', sakuraInstallConfirm: 'Scaricare e verificare frpc ufficiale 0.70.1 (circa {size} MB) dalla release ufficiale di frp, estraendo solo frpc nella directory privata DSH Mobile? Non vengono aggiunti servizi, PATH o avvio automatico.', sakuraInstallingFrpc: 'Installazione del componente frpc ufficiale. Mantieni DSH in esecuzione fino al termine.', sakuraFrpcReady: 'frpc ufficiale {version} installato e verificato.', sakuraFrpcMissing: 'frpc non è installato. Non viene scaricato nulla finché non premi il pulsante qui sotto.', sakuraFrpcInvalid: 'Verifica di frpc non riuscita. Rimuovilo completamente e reinstallalo.', sakuraPurge: 'Rimuovi completamente il componente frpc e la configurazione SakuraFrp', sakuraPurgeConfirm: 'Rimuovere completamente componente frpc, chiave di accesso, configurazione del tunnel e certificati di ingresso dalla directory privata DSH Mobile? Rete locale, dati DSH e altri programmi non sono interessati.', sakuraPurgingFrpc: 'Arresto del canale e rimozione dei file frpc gestiti da DSH Mobile…',
  sakuraTokenMissing: 'Nessuna chiave di accesso SakuraFrp salvata. Completa i passaggi sopra.', sakuraTokenInvalid: 'La chiave di accesso SakuraFrp non è valida. Copiala di nuovo dal pannello ufficiale e salvala.', sakuraApiUnreachable: 'Impossibile raggiungere l’API SakuraFrp. Controlla la rete del computer e riprova.', sakuraApiError: 'L’API SakuraFrp ha restituito un errore. Riprova più tardi o controlla la chiave di accesso.', sakuraTunnelMissing: 'Nessun tunnel salvato. Scegli prima un tunnel TCP e salvalo.', sakuraTunnelBanned: 'Questo tunnel è bannato da SakuraFrp. Risolvilo nel pannello ufficiale e riprova.', sakuraTunnelTypeUnsupported: 'Sono supportati solo tunnel TCP. Crea o scegli un tunnel TCP nel pannello SakuraFrp.', sakuraTunnelLocked: 'Questo tunnel è bloccato da SakuraFrp (ad esempio un nodo a pagamento) e non può essere modificato dal plugin.', sakuraTunnelPortUnavailable: 'Impossibile assegnare una porta locale a questo tunnel. Riprova o scegli un altro tunnel.', sakuraEntryUnknown: 'L’ingresso pubblico di questo tunnel è sconosciuto. Ricarica l’elenco dei tunnel.', sakuraConfigFetchFailed: 'Recupero della configurazione del tunnel SakuraFrp non riuscito. Riconnettiti.', sakuraLaunchFailed: 'Avvio di frpc non riuscito.', sakuraStartTimeout: 'Timeout in attesa del canale SakuraFrp. Riconnettiti.', sakuraStopped: 'La connessione SakuraFrp è stata arrestata.', sakuraExited: 'La connessione SakuraFrp è terminata in modo imprevisto. Riconnettiti.', sakuraInvalidOutput: 'frpc ha restituito uno stato non riconosciuto.', sakuraSettingsInvalid: 'Le impostazioni locali SakuraFrp non sono valide. Salva di nuovo chiave o tunnel.', sakuraPortReservationFailed: 'Impossibile riservare la porta del gateway DSH. Riprova.', remoteComponentLaunchFailed: 'Il componente remoto non si è avviato. Riconnettiti.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.zh, {
  trustedNetworksTitle: '额外可信网段 · 高级', trustedNetworksHelp: '保留当前局域网网段，只追加你可控的网络，例如路由接入的 WireGuard 网段。配对与 HTTPS 校验仍然保留。每行一个 CIDR，也可用空格或逗号分隔。', trustedNetworksLabel: '额外允许的来源网段', trustedNetworksSave: '保存网段', trustedNetworksUnavailable: '仅托管局域网配置支持此设置。', trustedNetworksRestart: '已保存，重启 DSH 后生效；不会立即中断当前连接。', trustedNetworksWindows: 'Windows 防火墙也需要放行这些来源网段；默认规则只允许 LocalSubnet。', trustedNetworksFailed: '暂时无法读取设置，请重新打开此区域后重试。', trustedNetworksInvalid: '保存失败。请填写有效的网络 CIDR，例如 11.24.0.0/24，并确认 DSH 可写入私有配置文件。',
  sakuraTokenSaved: '已安全保存；留空保持不变', sakuraTokenLabel: '访问密钥', sakuraTokenSavedNow: '访问密钥已保存，正在获取隧道信息…', sakuraTunnelsTitle: '选择 TCP 隧道', sakuraTunnelsRefresh: '获取隧道列表', sakuraTunnelSelect: '选择要使用的隧道', sakuraTunnelEmpty: '尚未保存隧道。保存访问密钥后点击「获取隧道列表」。', sakuraTunnelConfigured: '已选择隧道 {name}（#{id}）；点击下方「保存并连接」即可建立远程通道。', sakuraTunnelHint: '插件会把该隧道的本地指向自动设为 DSH 网关端口。', sakuraTunnelOnline: '在线', sakuraTunnelOffline: '离线', sakuraTunnelBannedPanel: '有隧道被禁用，请在 SakuraFrp 面板处理。', sakuraConfigureSave: '保存并连接', sakuraConfigured: '隧道已保存，正在建立远程通道…', sakuraInstallConfirm: '将从 frp 官方 Release 下载并校验 frpc 0.70.1（约 {size} MB），只提取 frpc 到 DSH Mobile 私有目录？不会安装服务、写入 PATH 或设置开机启动。', sakuraInstallingFrpc: '正在安装官方 frpc 组件。完成前请保持 DSH 运行。', sakuraFrpcReady: '官方 frpc {version} 已安装并通过校验。', sakuraFrpcMissing: 'frpc 尚未安装；点击下方按钮后才会开始下载。', sakuraFrpcInvalid: 'frpc 校验失败，请彻底清理后重新安装。', sakuraPurge: '彻底移除 frpc 组件与 SakuraFrp 配置', sakuraPurgeConfirm: '彻底移除 DSH Mobile 私有目录中的 frpc 组件、访问密钥、隧道配置和入口证书？不会影响局域网、DSH 数据或系统中的其他程序。', sakuraPurgingFrpc: '正在关闭通道并清理 DSH Mobile 管理的 frpc 文件…',
  sakuraTokenMissing: '尚未保存 SakuraFrp 访问密钥。请先完成上方准备步骤。', sakuraTokenInvalid: 'SakuraFrp 访问密钥无效，请在官网重新复制后保存。', sakuraApiUnreachable: '无法连接 SakuraFrp API。请检查这台电脑的网络后重试。', sakuraApiError: 'SakuraFrp API 返回了错误。请稍后重试，或检查访问密钥。', sakuraTunnelMissing: '尚未保存所选隧道。请先选择 TCP 隧道并保存。', sakuraTunnelBanned: '该隧道已被 SakuraFrp 禁用，请在官网面板处理后再试。', sakuraTunnelTypeUnsupported: '仅支持 TCP 类型隧道。请在 SakuraFrp 面板创建或选择一条 TCP 隧道。', sakuraTunnelLocked: '该隧道被 SakuraFrp 锁定（例如付费节点），暂不能由本插件编辑。', sakuraTunnelPortUnavailable: '无法为该隧道分配本机端口，请重试或换一条隧道。', sakuraEntryUnknown: '无法确定该隧道的公网入口，请重新获取隧道列表。', sakuraConfigFetchFailed: '获取 SakuraFrp 隧道配置失败，请重新连接。', sakuraLaunchFailed: 'frpc 未能启动。', sakuraStartTimeout: '等待 SakuraFrp 通道就绪超时，请重新连接。', sakuraStopped: 'SakuraFrp 连接已停止。', sakuraExited: 'SakuraFrp 连接意外退出，请重新连接。', sakuraInvalidOutput: 'frpc 返回了无法识别的状态。', sakuraSettingsInvalid: 'SakuraFrp 本机设置无效，请重新保存访问密钥或隧道。', sakuraPortReservationFailed: '无法预留 DSH 网关端口，请重试。', remoteComponentLaunchFailed: '远程组件未能启动，请重新连接。',
})

Object.assign(MOBILE_CONTROL_MESSAGES.en, {
  lanSetupTitle: 'Finish local network setup', lanSetupIntro: 'Choose the network shared by this computer and your phone. DSH Mobile creates private certificates only after you confirm.', lanSetupNetwork: 'Computer network', lanSetupChooseNetwork: 'Choose a network', lanSetupRecommended: 'Recommended', lanSetupNoNetworks: 'No private Wi-Fi or Ethernet address was found. Connect this computer to the local network, then scan again.', lanSetupRefresh: 'Scan again', lanSetupFirewallNote: 'Windows may request administrator approval for two inbound rules limited to the local subnet.', lanSetupConfigure: 'Configure local network', lanSetupConfiguring: 'Creating private certificates and local network rules…', lanSetupRequired: 'Local network setup has not been completed. Choose a network above to continue.', lanSetupRestart: 'Setup complete for {origin}. Restart DSH once to start local network access.', lanSetupFailed: 'Setup was not completed. Confirm the network selection and approve the Windows prompt, then try again.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.it, {
  lanSetupTitle: 'Completa la configurazione della rete locale', lanSetupIntro: 'Scegli la rete condivisa da questo computer e dal telefono. DSH Mobile crea certificati privati solo dopo la conferma.', lanSetupNetwork: 'Rete del computer', lanSetupChooseNetwork: 'Scegli una rete', lanSetupRecommended: 'Consigliata', lanSetupNoNetworks: 'Nessun indirizzo Wi-Fi o Ethernet privato trovato. Collega il computer alla rete locale e ripeti la ricerca.', lanSetupRefresh: 'Cerca di nuovo', lanSetupFirewallNote: 'Windows può richiedere l’approvazione amministratore per due regole in ingresso limitate alla sottorete locale.', lanSetupConfigure: 'Configura rete locale', lanSetupConfiguring: 'Creazione dei certificati privati e delle regole di rete locale…', lanSetupRequired: 'La configurazione della rete locale non è completa. Scegli una rete qui sopra per continuare.', lanSetupRestart: 'Configurazione completata per {origin}. Riavvia DSH una volta per attivare l’accesso locale.', lanSetupFailed: 'Configurazione non completata. Controlla la rete e approva la richiesta di Windows, quindi riprova.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.zh, {
  lanSetupTitle: '完成局域网配置', lanSetupIntro: '选择电脑与手机共同使用的网络。确认后才会生成私有证书，不会在安装时自动开放端口。', lanSetupNetwork: '电脑当前网络', lanSetupChooseNetwork: '请选择网络', lanSetupRecommended: '推荐', lanSetupNoNetworks: '未找到可用的私有 Wi-Fi 或以太网地址。请先让电脑接入局域网，然后重新扫描。', lanSetupRefresh: '重新扫描', lanSetupFirewallNote: 'Windows 可能请求管理员授权，仅创建两条限本地子网访问的入站规则。', lanSetupConfigure: '完成配置', lanSetupConfiguring: '正在生成私有证书并配置局域网规则…', lanSetupRequired: '尚未完成局域网配置，请选择上方网络继续。', lanSetupRestart: '已为 {origin} 完成配置。请重启一次 DSH，局域网访问会自动开启。', lanSetupFailed: '配置未完成。请确认网卡选择并允许 Windows 授权提示，然后重试。',
})

Object.assign(MOBILE_CONTROL_MESSAGES.en, {
  requestTimeout: 'The operation timed out. Confirm that DSH is still running, then try again.',
  diagnostics: 'Diagnostics', openDiagnostics: 'Open connection diagnostics', back: 'Back', backToMobile: 'Back to Mobile access', connectionDiagnostics: 'Connection diagnostics',
  diagnosticsIntro: 'Check versions, gateway, network adapter, firewall, and remote channel. The report is automatically redacted and never reads conversations or credentials.',
  diagnosticsNotRun: 'Not checked yet', diagnosticsStartHint: 'Select the button below to begin.', diagnosticsIdleMeta: 'Waiting to run · connection status only', diagnosticsStart: 'Start check', diagnosticsCopy: 'Copy redacted report', diagnosticsAdvanced: 'Advanced diagnostic details',
  diagnosticsComplete: 'Check complete', diagnosticsAttention: 'Some items need attention', diagnosticsProblem: 'Connection problems found', diagnosticsCompleteFallback: 'The check is complete.',
  diagnosticStatusOk: 'OK', diagnosticStatusWarning: 'Attention', diagnosticStatusError: 'Problem', diagnosticStatusInfo: 'Info', diagnosticItems: '{count} items', diagnosticCheck: 'Check', diagnosticAction: 'Suggested action',
  diagnosticNeedsAction: 'Needs action', diagnosticDetails: 'Check details', diagnosticOther: 'Other checks', diagnosticNoBlockers: '{count} checks · no blocking issues found', diagnosticNeedsCount: '{count} checks · {issues} need attention',
  diagnosticsChecking: 'Checking…', diagnosticsCheckingTitle: 'Checking connection', diagnosticsCheckingText: 'This usually takes a few seconds. The remote channel performs a real reachability test.', diagnosticsRunningMeta: 'Running · keep DSH online',
  diagnosticsIncomplete: 'Check not completed', diagnosticsReadFailed: 'Could not read diagnostics: {error}', diagnosticsUnavailable: 'Diagnostics service unavailable · try again later', diagnosticsRetry: 'Check again', diagnosticsCopied: 'Redacted report copied. You can paste it directly into an issue.', diagnosticsCopyManual: 'Clipboard access was denied. Details are expanded for manual copying.',
  diagnosticLabelVersions: 'Version compatibility', diagnosticLabelNetwork: 'Local network adapter', diagnosticLabelLan: 'Local network gateway', diagnosticLabelFirewall: 'Windows Firewall', diagnosticLabelRemote: 'Remote channel', diagnosticLabelPhone: 'Phone network',
})
Object.assign(MOBILE_CONTROL_MESSAGES.it, {
  requestTimeout: 'Operazione scaduta. Verifica che DSH sia ancora in esecuzione e riprova.',
  diagnostics: 'Diagnostica', openDiagnostics: 'Apri diagnostica connessione', back: 'Indietro', backToMobile: 'Torna ad Accesso mobile', connectionDiagnostics: 'Diagnostica connessione',
  diagnosticsIntro: 'Controlla versioni, gateway, scheda di rete, firewall e canale remoto. Il report viene anonimizzato automaticamente e non legge conversazioni o credenziali.',
  diagnosticsNotRun: 'Controllo non eseguito', diagnosticsStartHint: 'Premi il pulsante sotto per iniziare.', diagnosticsIdleMeta: 'In attesa · solo stato connessione', diagnosticsStart: 'Avvia controllo', diagnosticsCopy: 'Copia report anonimizzato', diagnosticsAdvanced: 'Dettagli diagnostici avanzati',
  diagnosticsComplete: 'Controllo completato', diagnosticsAttention: 'Alcuni elementi richiedono attenzione', diagnosticsProblem: 'Rilevati problemi di connessione', diagnosticsCompleteFallback: 'Controllo completato.',
  diagnosticStatusOk: 'OK', diagnosticStatusWarning: 'Attenzione', diagnosticStatusError: 'Problema', diagnosticStatusInfo: 'Informazione', diagnosticItems: '{count} elementi', diagnosticCheck: 'Controllo', diagnosticAction: 'Suggerimento',
  diagnosticNeedsAction: 'Da risolvere', diagnosticDetails: 'Dettagli controllo', diagnosticOther: 'Altri controlli', diagnosticNoBlockers: '{count} controlli · nessun problema bloccante', diagnosticNeedsCount: '{count} controlli · {issues} richiedono attenzione',
  diagnosticsChecking: 'Controllo…', diagnosticsCheckingTitle: 'Controllo connessione', diagnosticsCheckingText: 'Di solito richiede pochi secondi. Il canale remoto esegue un test reale di raggiungibilità.', diagnosticsRunningMeta: 'In esecuzione · mantieni DSH online',
  diagnosticsIncomplete: 'Controllo non completato', diagnosticsReadFailed: 'Impossibile leggere la diagnostica: {error}', diagnosticsUnavailable: 'Servizio diagnostico non disponibile · riprova più tardi', diagnosticsRetry: 'Ripeti controllo', diagnosticsCopied: 'Report anonimizzato copiato. Puoi incollarlo direttamente in una issue.', diagnosticsCopyManual: 'Il browser ha negato la copia. I dettagli sono stati aperti per la copia manuale.',
  diagnosticLabelVersions: 'Compatibilità versioni', diagnosticLabelNetwork: 'Scheda rete locale', diagnosticLabelLan: 'Gateway rete locale', diagnosticLabelFirewall: 'Windows Firewall', diagnosticLabelRemote: 'Canale remoto', diagnosticLabelPhone: 'Rete telefono',
})
Object.assign(MOBILE_CONTROL_MESSAGES.zh, {
  requestTimeout: '操作超时，请确认 DSH 仍在运行后重试。',
  diagnostics: '诊断', openDiagnostics: '打开连接诊断', back: '返回', backToMobile: '返回移动访问', connectionDiagnostics: '连接诊断',
  diagnosticsIntro: '检查版本、网关、网卡、防火墙和远程通道。报告自动脱敏，不读取对话或凭据。', diagnosticsNotRun: '尚未检查', diagnosticsStartHint: '点击下方按钮开始。', diagnosticsIdleMeta: '等待运行 · 仅收集连接状态', diagnosticsStart: '开始检查', diagnosticsCopy: '复制脱敏报告', diagnosticsAdvanced: '高级诊断详情',
  diagnosticsComplete: '检查完成', diagnosticsAttention: '有项目需要留意', diagnosticsProblem: '发现连接问题', diagnosticsCompleteFallback: '检查已完成。', diagnosticStatusOk: '正常', diagnosticStatusWarning: '注意', diagnosticStatusError: '问题', diagnosticStatusInfo: '说明', diagnosticItems: '{count} 项', diagnosticCheck: '检查项', diagnosticAction: '建议', diagnosticNeedsAction: '需要处理', diagnosticDetails: '检查详情', diagnosticOther: '其他检查', diagnosticNoBlockers: '{count} 项检查 · 未发现阻断问题', diagnosticNeedsCount: '{count} 项检查 · {issues} 项需要处理',
  diagnosticsChecking: '正在检查…', diagnosticsCheckingTitle: '正在检查连接', diagnosticsCheckingText: '通常几秒内完成。远程通道会执行一次真实可达性测试。', diagnosticsRunningMeta: '正在运行 · 请保持 DSH 在线', diagnosticsIncomplete: '检查未完成', diagnosticsReadFailed: '无法读取诊断结果：{error}', diagnosticsUnavailable: '诊断服务暂不可用 · 请稍后重试', diagnosticsRetry: '重新检查', diagnosticsCopied: '脱敏报告已复制，可直接粘贴到 Issue。', diagnosticsCopyManual: '浏览器未允许复制，已展开详情，请手动复制。',
  diagnosticLabelVersions: '版本兼容', diagnosticLabelNetwork: '局域网网卡', diagnosticLabelLan: '局域网网关', diagnosticLabelFirewall: 'Windows 防火墙', diagnosticLabelRemote: '远程通道', diagnosticLabelPhone: '手机网络',
})

export const LOCALIZED_DIAGNOSTIC_COPY = {
  en: {
    versions: 'Installed plugin, DSH, and minimum Android app versions are shown.',
    networkOk: 'The configured local network adapter is available.', networkError: 'The saved local network adapter is unavailable.', networkInfo: 'A fixed local network configuration is in use.', networkAction: 'Run dsh-mobile setup again.',
    lanOk: 'The local gateway is listening and pairing is available.', lanInfo: 'Local network access is currently off.', lanAction: 'Enable local network access when the phone must connect directly.',
    firewallOk: 'Local TCP and discovery firewall rules are enabled.', firewallWarning: 'The complete local network firewall rules were not found.', firewallInfo: 'The system did not allow the plugin to read firewall status.', firewallAction: 'Run dsh-mobile setup as administrator and check the firewall rules.',
    remoteOk: 'The remote public address passed the reachability check.', remoteWarning: 'The remote channel needs attention or is still connecting.', remoteError: 'The remote connection is not currently reachable.', remoteInfo: 'Remote access is currently off.', remoteAction: 'Return to Remote access, follow the provider guidance, and reconnect.',
    phone: 'The computer cannot determine whether the router isolates the phone.', phoneAction: 'Confirm the phone and computer use the same network, then disable guest-network or AP isolation.',
    reportTitle: 'DSH Mobile diagnostic report', generated: 'Generated',
  },
  it: {
    versions: 'Sono indicate le versioni installate di plugin e DSH e la versione minima dell’app Android.',
    networkOk: 'La scheda di rete locale configurata è disponibile.', networkError: 'La scheda di rete locale salvata non è disponibile.', networkInfo: 'È in uso una configurazione di rete locale fissa.', networkAction: 'Esegui di nuovo dsh-mobile setup.',
    lanOk: 'Il gateway locale è in ascolto e l’abbinamento è disponibile.', lanInfo: 'L’accesso dalla rete locale è disattivato.', lanAction: 'Attiva l’accesso locale quando il telefono deve collegarsi direttamente.',
    firewallOk: 'Le regole firewall TCP locale e di rilevamento sono attive.', firewallWarning: 'Le regole firewall complete per la rete locale non sono state trovate.', firewallInfo: 'Il sistema non ha consentito al plugin di leggere lo stato del firewall.', firewallAction: 'Esegui dsh-mobile setup come amministratore e controlla le regole firewall.',
    remoteOk: 'L’indirizzo pubblico remoto ha superato il test di raggiungibilità.', remoteWarning: 'Il canale remoto richiede attenzione o è ancora in connessione.', remoteError: 'La connessione remota non è al momento raggiungibile.', remoteInfo: 'L’accesso remoto è disattivato.', remoteAction: 'Torna ad Accesso remoto, segui le indicazioni del provider e riconnettiti.',
    phone: 'Il computer non può stabilire se il router isola il telefono.', phoneAction: 'Verifica che telefono e computer usino la stessa rete, poi disattiva rete ospiti o isolamento AP.',
    reportTitle: 'Report diagnostico DSH Mobile', generated: 'Generato',
  },
  zh: {
    versions: '已显示插件、DSH 和 Android App 最低版本。',
    networkOk: '已配置的局域网网卡可用。', networkError: '已保存的局域网网卡不可用。', networkInfo: '当前使用固定局域网配置。', networkAction: '重新运行 dsh-mobile setup。',
    lanOk: '局域网网关正在监听，配对入口可用。', lanInfo: '局域网访问当前未开启。', lanAction: '需要手机直连时开启局域网访问。',
    firewallOk: '局域网 TCP 与发现防火墙规则已启用。', firewallWarning: '未找到完整的局域网防火墙规则。', firewallInfo: '系统未允许插件读取防火墙状态。', firewallAction: '以管理员身份运行 dsh-mobile setup 并检查防火墙规则。',
    remoteOk: '远程公网地址已通过可达性检查。', remoteWarning: '远程通道需要处理或仍在连接。', remoteError: '远程连接当前不可达。', remoteInfo: '远程访问当前未开启。', remoteAction: '返回远程访问，按提供方提示操作并重新连接。',
    phone: '电脑无法判断路由器是否隔离了手机。', phoneAction: '确认手机与电脑使用同一网络，并关闭访客网络或 AP 隔离。',
    reportTitle: 'DSH Mobile 诊断报告', generated: '生成时间',
  },
} satisfies Record<MobileControlLocale, {
  versions: string
  networkOk: string
  networkError: string
  networkInfo: string
  networkAction: string
  lanOk: string
  lanInfo: string
  lanAction: string
  firewallOk: string
  firewallWarning: string
  firewallInfo: string
  firewallAction: string
  remoteOk: string
  remoteWarning: string
  remoteError: string
  remoteInfo: string
  remoteAction: string
  phone: string
  phoneAction: string
  reportTitle: string
  generated: string
}>

Object.assign(MOBILE_CONTROL_MESSAGES.en, {
  cloudflaredBadge: "Named tunnel",
  cloudflaredDescription: "Installs the official cloudflared client on demand and builds the remote channel over a Cloudflare named tunnel; one hostname that survives restarts, using a Cloudflare account token.",
  prepareCloudflared: "Prepare cloudflared",
  cloudflaredUnsupported: "Windows x64, Linux x64/arm64, and macOS x64/arm64 are supported.",
  cloudflaredNotInstalled: "Not installed. A fixed version is downloaded from the official cloudflared release page only after you click the button below.",
  cloudflaredReady: "Official component {version} is ready.",
  cloudflaredNamedNote: "Named tunnel: the hostname above stays the same across restarts and Cloudflare routes it to the local forward port. The connector token is stored only in the DSH Mobile private directory, is handed to cloudflared through its environment rather than the command line, and is never shown again once saved.",
  cloudflaredComponentNote: "Downloaded from the official cloudflared release page and verified at a fixed version only after you choose Install. The client is started with automatic updates disabled. It does not add a system service, startup item, registry entry, or PATH entry.",
  installConfirmCloudflared: "Download and verify cloudflared {size} from the official release page and store it only in the DSH Mobile private directory? No system service, PATH/registry entry, or startup item is added.",
  installingCloudflared: "Installing the official cloudflared component. Keep DSH running until it completes.",
  purgeCloudflared: "Completely remove the cloudflared component",
  purgeCloudflaredConfirm: "Completely remove the cloudflared component and its runtime logs from the DSH Mobile private directory? Local network access, DSH data, and other system programs are unaffected.",
  purgingCloudflared: "Stopping the channel and removing cloudflared files managed by DSH Mobile…",
  cloudflaredMissing: "The official cloudflared component is not installed. Complete the preparation steps above.",
  cloudflaredInvalid: "cloudflared component verification failed. Remove it completely and reinstall.",
  cloudflaredPortUnavailable: "Could not allocate a local remote-gateway port. Try again.",
  cloudflaredLaunchFailed: "The cloudflared client failed to start.",
  cloudflaredTimeout: "Timed out waiting for the tunnel to become reachable. Reconnect.",
  cloudflaredStopped: "The cloudflared connection stopped.",
  cloudflaredExited: "The cloudflared connection exited unexpectedly. Reconnect.",
  cloudflaredOutputInvalid: "cloudflared returned an unrecognized status.",
  cloudflaredOriginInvalid: "The public address returned by cloudflared failed validation.",
  cloudflaredComponentUnsupported: "This build cannot run the cloudflared component.",
  cloudflaredDownloadHashMismatch: "The downloaded cloudflared failed its SHA-256 verification. Retry the install.",
  cloudflaredDownloadSizeMismatch: "The downloaded cloudflared is not the pinned size. Retry the install.",
  cloudflaredDownloadRedirectMissing: "The download page stopped redirecting to the release asset. Retry later, or install from the official page manually.",
  cloudflaredDownloadRedirectInvalid: "The download redirect did not point at a GitHub release asset, so it was refused.",
  cloudflaredDownloadRedirectRejected: "The download redirect was refused by policy. Retry later, or install from the official page manually.",
  cloudflaredExecutableHashMismatch: "The installed cloudflared no longer matches the verified build. Remove it completely and install again.",
  cloudflaredPortReservationFailed: "Could not reserve a local port for the tunnel. Try again.",
  cloudflaredTunnelTargetInvalid: "The saved tunnel configuration is not a regular file. Remove it and save the settings again.",
  cloudflaredTunnelSaving: "Saving the tunnel settings and reconnecting cloudflared…",
  cloudflaredTunnelForgetting: "Removing the saved tunnel token…",
  cloudflaredTunnelHostname: "Public hostname",
  cloudflaredTunnelHostnamePlaceholder: "dsh.example.com",
  cloudflaredTunnelPort: "Local forward port",
  cloudflaredTunnelToken: "Connector token",
  cloudflaredTunnelTokenPlaceholder: "Paste the tunnel token from the Cloudflare dashboard",
  cloudflaredTunnelTokenSaved: "A token is saved. Leave blank to keep it.",
  cloudflaredTunnelSave: "Save and connect",
  cloudflaredTunnelConfigured: "Named tunnel configured: {hostname} reaches this computer on 127.0.0.1:{port}.",
  cloudflaredTunnelMissing: "No named tunnel configured yet.",
  cloudflaredTunnelHint: "In the Cloudflare dashboard create a tunnel, then set its public hostname to http://127.0.0.1:{port}. The token is stored only in the DSH Mobile private directory and is never shown again after saving.",
  cloudflaredTunnelForget: "Remove the saved token",
  cloudflaredTunnelForgetConfirm: "Remove the saved tunnel token and stop the cloudflared channel? Nothing reconnects on its own: switch the channel back on afterwards. The tunnel still exists in your Cloudflare account, and its public hostname is unchanged.",
  cloudflaredTunnelInvalid: "The saved named-tunnel configuration is unreadable. Save the settings again.",
  cloudflaredTunnelPortUnavailable: "The configured local forward port is unavailable. Cloudflare routes the public hostname to that exact port, so free it or choose another one.",
  cloudflaredTunnelHostnameInvalid: "Enter a public hostname under a domain on this Cloudflare account, for example dsh.example.com.",
  cloudflaredTunnelPortInvalid: "Enter a forward port between 1024 and 65535.",
  cloudflaredTunnelPortReserved: "Port 3443 is reserved for the DSH Mobile LAN gateway and is always occupied. Choose another port, such as 3444 or 3445.",
  cloudflaredTunnelTokenInvalid: "That does not look like a tunnel token. Copy the whole token from the Cloudflare dashboard.",
  cloudflaredTunnelSettingsInvalid: "The tunnel settings were rejected.",
  cloudflaredTunnelConfigMissing: "Enter the token, hostname, and port to use a named tunnel.",
})

Object.assign(MOBILE_CONTROL_MESSAGES.it, {
  cloudflaredBadge: "Tunnel con nome",
  cloudflaredDescription: "Installa su richiesta il client cloudflared ufficiale e crea il canale remoto tramite un tunnel con nome Cloudflare; un hostname stabile tra i riavvii, con il token di un account Cloudflare.",
  prepareCloudflared: "Prepara cloudflared",
  cloudflaredUnsupported: "Sono supportati Windows x64, Linux x64/arm64 e macOS x64/arm64.",
  cloudflaredNotInstalled: "Non installato. Una versione fissa viene scaricata dalla pagina ufficiale di cloudflared solo dopo aver premuto il pulsante.",
  cloudflaredReady: "Componente ufficiale {version} pronto.",
  cloudflaredNamedNote: "Tunnel con nome: l’hostname qui sopra resta lo stesso tra i riavvii e Cloudflare lo instrada verso la porta di inoltro locale. Il token del connettore è salvato solo nella directory privata DSH Mobile, viene passato a cloudflared tramite l’ambiente e non tramite la riga di comando, e dopo il salvataggio non viene più mostrato.",
  cloudflaredComponentNote: "Viene scaricato dalla pagina ufficiale di cloudflared e verificato a una versione fissa solo dopo aver scelto Installa. Il client viene avviato con gli aggiornamenti automatici disattivati. Non aggiunge servizi di sistema, avvio automatico, voci di registro o PATH.",
  installConfirmCloudflared: "Scaricare e verificare cloudflared {size} dalla pagina ufficiale e salvarlo solo nella directory privata DSH Mobile? Non vengono aggiunti servizi, PATH/registro o avvio automatico.",
  installingCloudflared: "Installazione del componente cloudflared ufficiale. Mantieni DSH in esecuzione fino al termine.",
  purgeCloudflared: "Rimuovi completamente il componente cloudflared",
  purgeCloudflaredConfirm: "Rimuovere completamente il componente cloudflared e i log runtime dalla directory privata DSH Mobile? Rete locale, dati DSH e altri programmi non sono interessati.",
  purgingCloudflared: "Arresto del canale e rimozione dei file cloudflared gestiti da DSH Mobile…",
  cloudflaredMissing: "Il componente cloudflared ufficiale non è installato. Completa i passaggi sopra.",
  cloudflaredInvalid: "Verifica del componente cloudflared non riuscita. Rimuovilo completamente e reinstallalo.",
  cloudflaredPortUnavailable: "Impossibile assegnare una porta locale al gateway remoto. Riprova.",
  cloudflaredLaunchFailed: "Il client cloudflared non è stato avviato.",
  cloudflaredTimeout: "Timeout in attesa che il tunnel diventi raggiungibile. Riconnettiti.",
  cloudflaredStopped: "La connessione cloudflared è stata arrestata.",
  cloudflaredExited: "La connessione cloudflared è terminata in modo imprevisto. Riconnettiti.",
  cloudflaredOutputInvalid: "cloudflared ha restituito uno stato non riconosciuto.",
  cloudflaredOriginInvalid: "L’indirizzo pubblico restituito da cloudflared non ha superato la verifica.",
  cloudflaredComponentUnsupported: "Questa build non può eseguire il componente cloudflared.",
  cloudflaredDownloadHashMismatch: "Il cloudflared scaricato non ha superato la verifica SHA-256. Riprova l’installazione.",
  cloudflaredDownloadSizeMismatch: "Il cloudflared scaricato non ha la dimensione prevista. Riprova l’installazione.",
  cloudflaredDownloadRedirectMissing: "La pagina di download non reindirizza più all’asset della release. Riprova più tardi o installa manualmente dalla pagina ufficiale.",
  cloudflaredDownloadRedirectInvalid: "Il reindirizzamento di download non puntava a un asset di release GitHub ed è stato rifiutato.",
  cloudflaredDownloadRedirectRejected: "Il reindirizzamento di download è stato rifiutato dalle regole. Riprova più tardi o installa manualmente dalla pagina ufficiale.",
  cloudflaredExecutableHashMismatch: "Il cloudflared installato non corrisponde più alla build verificata. Rimuovilo completamente e reinstalla.",
  cloudflaredPortReservationFailed: "Impossibile riservare una porta locale per il tunnel. Riprova.",
  cloudflaredTunnelTargetInvalid: "La configurazione salvata del tunnel non è un file regolare. Rimuovila e salva di nuovo le impostazioni.",
  cloudflaredTunnelSaving: "Salvataggio delle impostazioni e riconnessione di cloudflared…",
  cloudflaredTunnelForgetting: "Rimozione del token del tunnel salvato…",
  cloudflaredTunnelHostname: "Hostname pubblico",
  cloudflaredTunnelHostnamePlaceholder: "dsh.example.com",
  cloudflaredTunnelPort: "Porta di inoltro locale",
  cloudflaredTunnelToken: "Token del connettore",
  cloudflaredTunnelTokenPlaceholder: "Incolla il token del tunnel dalla dashboard Cloudflare",
  cloudflaredTunnelTokenSaved: "Un token è salvato. Lascia vuoto per mantenerlo.",
  cloudflaredTunnelSave: "Salva e connetti",
  cloudflaredTunnelConfigured: "Tunnel con nome configurato: {hostname} raggiunge questo computer su 127.0.0.1:{port}.",
  cloudflaredTunnelMissing: "Nessun tunnel con nome configurato.",
  cloudflaredTunnelHint: "Nella dashboard Cloudflare crea un tunnel e imposta il suo hostname pubblico su http://127.0.0.1:{port}. Il token è salvato solo nella directory privata DSH Mobile e non viene più mostrato dopo il salvataggio.",
  cloudflaredTunnelForget: "Rimuovi il token salvato",
  cloudflaredTunnelForgetConfirm: "Rimuovere il token salvato e arrestare il canale cloudflared? Nulla si riconnette da solo: riattiva il canale in seguito. Il tunnel resta nel tuo account Cloudflare e il suo hostname pubblico non cambia.",
  cloudflaredTunnelInvalid: "La configurazione salvata del tunnel con nome non è leggibile. Salva di nuovo le impostazioni.",
  cloudflaredTunnelPortUnavailable: "La porta di inoltro locale configurata non è disponibile. Cloudflare instrada l’hostname pubblico esattamente su quella porta: liberala o scegline un’altra.",
  cloudflaredTunnelHostnameInvalid: "Inserisci un hostname pubblico sotto un dominio di questo account Cloudflare, ad esempio dsh.example.com.",
  cloudflaredTunnelPortInvalid: "Inserisci una porta di inoltro tra 1024 e 65535.",
  cloudflaredTunnelPortReserved: "La porta 3443 è riservata al gateway LAN di DSH Mobile ed è sempre occupata. Scegli un’altra porta, ad esempio 3444 o 3445.",
  cloudflaredTunnelTokenInvalid: "Non sembra un token di tunnel. Copia il token completo dalla dashboard Cloudflare.",
  cloudflaredTunnelSettingsInvalid: "Le impostazioni del tunnel sono state rifiutate.",
  cloudflaredTunnelConfigMissing: "Inserisci token, hostname e porta per usare un tunnel con nome.",
})

Object.assign(MOBILE_CONTROL_MESSAGES.zh, {
  cloudflaredBadge: "命名隧道",
  cloudflaredDescription: "按需安装官方 cloudflared 客户端，通过 Cloudflare 命名隧道建立远程通道；地址固定、重启不变，使用 Cloudflare 账号令牌。",
  prepareCloudflared: "准备 cloudflared",
  cloudflaredUnsupported: "支持 Windows x64、Linux x64/arm64 与 macOS x64/arm64。",
  cloudflaredNotInstalled: "尚未安装。只有点击下方按钮后，才会从 cloudflared 官方发布页下载固定版本。",
  cloudflaredReady: "官方组件 {version} 已就绪。",
  cloudflaredNamedNote: "命名隧道：上面的公网域名重启后不变，由 Cloudflare 转发到本机转发端口。连接器令牌只保存在 DSH Mobile 私有目录，经环境变量而非命令行传给 cloudflared，保存后不再显示。",
  cloudflaredComponentNote: "仅在你点击安装后从 cloudflared 官方发布页下载并校验固定版本，且启动时关闭自动更新。不会写入系统服务、开机启动、注册表或 PATH。",
  installConfirmCloudflared: "将从 cloudflared 官方发布页下载并校验固定版本（{size}），仅保存到 DSH Mobile 私有目录。不会安装系统服务、写入 PATH/注册表或设置开机启动。是否继续？",
  installingCloudflared: "正在安装 cloudflared 官方组件。完成前请保持 DSH 运行。",
  purgeCloudflared: "彻底移除 cloudflared 组件",
  purgeCloudflaredConfirm: "彻底移除 DSH Mobile 私有目录中的 cloudflared 组件和运行日志？不会影响局域网、DSH 数据或系统中的其他程序。",
  purgingCloudflared: "正在关闭通道并清理 DSH Mobile 管理的 cloudflared 文件…",
  cloudflaredMissing: "cloudflared 官方组件尚未安装。请先完成上方准备步骤。",
  cloudflaredInvalid: "cloudflared 组件校验失败。请彻底移除后重新安装。",
  cloudflaredPortUnavailable: "无法分配本机远程网关端口，请重试。",
  cloudflaredLaunchFailed: "cloudflared 客户端未能启动。",
  cloudflaredTimeout: "等待隧道可用超时，请重新连接。",
  cloudflaredStopped: "cloudflared 连接已停止。",
  cloudflaredExited: "cloudflared 连接意外退出，请重新连接。",
  cloudflaredOutputInvalid: "cloudflared 返回了无法识别的状态。",
  cloudflaredOriginInvalid: "cloudflared 返回的公网地址未通过校验。",
  cloudflaredComponentUnsupported: "当前构建无法运行 cloudflared 组件。",
  cloudflaredDownloadHashMismatch: "下载的 cloudflared 未通过 SHA-256 校验。请重新安装。",
  cloudflaredDownloadSizeMismatch: "下载的 cloudflared 体积与固定版本不符。请重新安装。",
  cloudflaredDownloadRedirectMissing: "下载页不再跳转到发布资源。请稍后重试，或按官方页面手动安装。",
  cloudflaredDownloadRedirectInvalid: "下载跳转的目标不是 GitHub 发布资源，已被拒绝。",
  cloudflaredDownloadRedirectRejected: "下载跳转未通过校验规则。请稍后重试，或按官方页面手动安装。",
  cloudflaredExecutableHashMismatch: "已安装的 cloudflared 与校验过的版本不一致。请彻底移除后重新安装。",
  cloudflaredPortReservationFailed: "无法为隧道预留本机端口，请重试。",
  cloudflaredTunnelTargetInvalid: "已保存的隧道配置不是普通文件。请移除后重新保存设置。",
  cloudflaredTunnelSaving: "正在保存隧道设置并重新连接 cloudflared…",
  cloudflaredTunnelForgetting: "正在移除已保存的隧道令牌…",
  cloudflaredTunnelHostname: "公网域名",
  cloudflaredTunnelHostnamePlaceholder: "dsh.example.com",
  cloudflaredTunnelPort: "本机转发端口",
  cloudflaredTunnelToken: "连接器令牌",
  cloudflaredTunnelTokenPlaceholder: "粘贴 Cloudflare 控制台里的隧道令牌",
  cloudflaredTunnelTokenSaved: "已保存令牌，留空表示不更改。",
  cloudflaredTunnelSave: "保存并连接",
  cloudflaredTunnelConfigured: "命名隧道已配置：{hostname} 将转发到本机 127.0.0.1:{port}。",
  cloudflaredTunnelMissing: "尚未配置命名隧道。",
  cloudflaredTunnelHint: "先在 Cloudflare 控制台创建隧道，并把它的公开主机名指向 http://127.0.0.1:{port}。令牌只保存在 DSH Mobile 私有目录，保存后不会再显示。",
  cloudflaredTunnelForget: "移除已保存的令牌",
  cloudflaredTunnelForgetConfirm: "移除已保存的隧道令牌并停止 cloudflared 通道？不会自动重连，之后需要手动重新打开开关。Cloudflare 账号里的隧道本身仍在，公开主机名也不会改变。",
  cloudflaredTunnelInvalid: "已保存的命名隧道配置无法读取。请重新保存设置。",
  cloudflaredTunnelPortUnavailable: "配置的本机转发端口不可用。Cloudflare 把公开主机名固定转发到该端口，请释放它或换一个端口。",
  cloudflaredTunnelHostnameInvalid: "请填写本 Cloudflare 账号下某个域名的公开主机名，例如 dsh.example.com。",
  cloudflaredTunnelPortInvalid: "请填写 1024 到 65535 之间的转发端口。",
  cloudflaredTunnelPortReserved: "3443 已留给 DSH Mobile 局域网网关，且始终被占用。请换一个端口，例如 3444 或 3445。",
  cloudflaredTunnelTokenInvalid: "这不像是一个隧道令牌。请从 Cloudflare 控制台完整复制令牌。",
  cloudflaredTunnelSettingsInvalid: "隧道设置未通过校验。",
  cloudflaredTunnelConfigMissing: "使用命名隧道需要同时填写令牌、公网域名和端口。",
})

export const DIAGNOSTIC_REASON_MESSAGES = {
  en: {
    'lan-setup-required': ['Local network setup has not been completed.', 'Return to Local network and choose a network to finish setup.'],
    'versions-current': ['Installed plugin, DSH, and minimum Android app versions are shown.', ''],
    'network-unavailable': ['The saved local network adapter is unavailable.', 'Run dsh-mobile setup again.'],
    'network-interface': ['Using network interface {interfaceName}.', ''],
    'network-fixed': ['A fixed local network configuration is in use.', ''],
    'lan-ready': ['The local gateway is listening at {endpointSuffix}; pairing is available.', ''],
    'lan-off': ['Local network access is currently off.', 'Enable local network access when the phone must connect directly.'],
    'firewall-ready': ['Local TCP and discovery firewall rules are enabled.', ''],
    'firewall-missing': ['The complete local network firewall rules were not found.', 'Run dsh-mobile setup as administrator and check the firewall rules.'],
    'firewall-unknown': ['The system did not allow the plugin to read firewall status.', 'If the phone cannot find this computer, run setup as administrator.'],
    'remote-off': ['Remote access through {provider} is currently off.', ''],
    'remote-ready': ['{provider} endpoint {endpointSuffix} is reachable in about {latencyMs} ms.', ''],
    'remote-ready-via-proxy': ['The computer reached {provider} endpoint {endpointSuffix} through its configured proxy in about {latencyMs} ms; phone reachability is not verified.', 'Test the connection from the phone’s network.'],
    'remote-rate-limited': ['{provider} endpoint {endpointSuffix} is reachable, but this check observed rate limiting.', 'Try again later; older sessions load on demand to reduce traffic.'],
    'remote-rate-limited-via-proxy': ['The computer reached {provider} endpoint {endpointSuffix} through its proxy, but the service rate-limited this check; phone reachability is not verified.', 'Try again later and test from the phone’s network.'],
    'remote-unreachable': ['{provider} reports ready, but endpoint {endpointSuffix} is not reachable.', 'Reconnect, then check the provider status if it still fails.'],
    'remote-connecting': ['The {provider} remote channel is still connecting.', 'Wait briefly, then check again.'],
    'remote-controller-error': ['The {provider} controller reported {controllerCode}.', 'Return to Remote access and reconnect.'],
    'competing-remote-channel': ['Another remote plugin is injecting its own request channel; the phone may show that plugin’s pairing screen.', 'Turn off dsh-remote-web-ui remote access on the computer, refresh, and pair using the current DSH Mobile QR code. Do not mix pairing codes.'],
    'phone-network-unknown': ['The computer cannot determine whether the router isolates the phone.', 'Confirm the phone and computer use the same network, then disable guest-network or AP isolation.'],
  },
  it: {
    'lan-setup-required': ['La configurazione della rete locale non è completa.', 'Torna a Rete locale e scegli una rete per completare la configurazione.'],
    'versions-current': ['Sono indicate le versioni installate di plugin e DSH e la versione minima dell’app Android.', ''],
    'network-unavailable': ['La scheda di rete locale salvata non è disponibile.', 'Esegui di nuovo dsh-mobile setup.'],
    'network-interface': ['È in uso l’interfaccia di rete {interfaceName}.', ''],
    'network-fixed': ['È in uso una configurazione di rete locale fissa.', ''],
    'lan-ready': ['Il gateway locale è in ascolto su {endpointSuffix}; l’abbinamento è disponibile.', ''],
    'lan-off': ['L’accesso dalla rete locale è disattivato.', 'Attiva l’accesso locale quando il telefono deve collegarsi direttamente.'],
    'firewall-ready': ['Le regole firewall TCP locale e di rilevamento sono attive.', ''],
    'firewall-missing': ['Le regole firewall complete per la rete locale non sono state trovate.', 'Esegui dsh-mobile setup come amministratore e controlla le regole firewall.'],
    'firewall-unknown': ['Il sistema non ha consentito al plugin di leggere lo stato del firewall.', 'Se il telefono non trova il computer, esegui setup come amministratore.'],
    'remote-off': ['L’accesso remoto tramite {provider} è disattivato.', ''],
    'remote-ready': ['L’endpoint {provider} {endpointSuffix} è raggiungibile in circa {latencyMs} ms.', ''],
    'remote-ready-via-proxy': ['Il computer ha raggiunto l’endpoint {provider} {endpointSuffix} tramite il proxy configurato in circa {latencyMs} ms; la raggiungibilità dal telefono non è verificata.', 'Prova la connessione dalla rete del telefono.'],
    'remote-rate-limited': ['L’endpoint {provider} {endpointSuffix} è raggiungibile, ma il controllo ha rilevato una limitazione temporanea.', 'Riprova più tardi; le sessioni precedenti vengono caricate su richiesta per ridurre il traffico.'],
    'remote-rate-limited-via-proxy': ['Il computer ha raggiunto l’endpoint {provider} {endpointSuffix} tramite proxy, ma il servizio ha limitato questo controllo; la raggiungibilità dal telefono non è verificata.', 'Riprova più tardi e verifica dalla rete del telefono.'],
    'remote-unreachable': ['{provider} risulta pronto, ma l’endpoint {endpointSuffix} non è raggiungibile.', 'Riconnettiti; se il problema continua, controlla lo stato del provider.'],
    'remote-connecting': ['Il canale remoto {provider} è ancora in connessione.', 'Attendi qualche istante e ripeti il controllo.'],
    'remote-controller-error': ['Il controller {provider} ha segnalato {controllerCode}.', 'Torna ad Accesso remoto e riconnettiti.'],
    'competing-remote-channel': ['Un altro plugin remoto sta inserendo il proprio canale di richieste; sul telefono potrebbe apparire la sua schermata di abbinamento.', 'Disattiva l’accesso remoto di dsh-remote-web-ui sul computer, aggiorna la pagina e usa il codice QR corrente di DSH Mobile. Non mescolare i codici.'],
    'phone-network-unknown': ['Il computer non può stabilire se il router isola il telefono.', 'Verifica che telefono e computer usino la stessa rete, poi disattiva rete ospiti o isolamento AP.'],
  },
  zh: {
    'lan-setup-required': ['尚未完成局域网初始化。', '返回局域网页选择网卡并完成配置。'],
    'versions-current': ['已显示插件、DSH 和 Android App 最低版本。', ''],
    'network-unavailable': ['已保存的局域网网卡当前不可用。', '重新运行 dsh-mobile setup。'],
    'network-interface': ['正在使用网卡 {interfaceName}。', ''],
    'network-fixed': ['当前使用固定局域网配置。', ''],
    'lan-ready': ['局域网网关正在监听 {endpointSuffix}，配对入口可用。', ''],
    'lan-off': ['局域网访问当前未开启。', '手机需要直连时开启局域网访问。'],
    'firewall-ready': ['局域网 TCP 与发现防火墙规则已启用。', ''],
    'firewall-missing': ['未找到完整的局域网防火墙规则。', '以管理员身份运行 dsh-mobile setup 并检查防火墙规则。'],
    'firewall-unknown': ['系统未允许插件读取防火墙状态。', '若手机找不到电脑，请以管理员身份运行 setup。'],
    'remote-off': ['{provider} 远程访问当前未启用。', ''],
    'remote-ready': ['{provider} 端点 {endpointSuffix} 可达，往返约 {latencyMs} ms。', ''],
    'remote-ready-via-proxy': ['电脑经已配置代理访问 {provider} 端点 {endpointSuffix}，约 {latencyMs} ms；尚未验证手机网络是否可达。', '请用手机当前网络实际连接测试。'],
    'remote-rate-limited': ['{provider} 端点 {endpointSuffix} 可达，但本次检查观察到服务限流。', '稍后重试；旧会话会按需加载以减少流量。'],
    'remote-rate-limited-via-proxy': ['电脑经代理访问 {provider} 端点 {endpointSuffix} 时遇到限流；尚未验证手机网络是否可达。', '稍后重试，并用手机当前网络实际连接测试。'],
    'remote-unreachable': ['{provider} 显示已就绪，但端点 {endpointSuffix} 暂不可达。', '点击重新连接；仍失败时检查提供方状态。'],
    'remote-connecting': ['{provider} 远程通道仍在连接。', '等待片刻后重新检查。'],
    'remote-controller-error': ['{provider} 控制器报告 {controllerCode}。', '返回远程访问并重新连接。'],
    'competing-remote-channel': ['检测到另一个远程插件注入自己的请求通道；手机可能显示它的配对页面。', '在电脑端关闭 dsh-remote-web-ui 的远程访问并刷新，再用 DSH Mobile 当前二维码配对；不要混用配对码。'],
    'phone-network-unknown': ['电脑无法判断路由器是否隔离了手机。', '确认手机与电脑使用同一网络，并关闭访客网络或 AP 隔离。'],
  },
} as const

// The PC 端 tab: a friend opens the entry link on a Windows PC and installs the
// page as a desktop app. The desktop customization layer is separate from this
// owner-facing panel copy.
Object.assign(MOBILE_CONTROL_MESSAGES.en, {
  pc: 'PC', pcAccess: 'PC access',
  pcIntro: 'Hand a friend on a Windows PC a DSH client: send them the access link and they open it in Edge or Chrome — no pairing code to type.',
  pcNoChannels: 'No PC entry is available yet. Turn on local network access or remote access first.',
  pcCopyUrl: 'Copy', pcCopyUrlAria: 'Copy the {channel} PC entry address', pcUrlCopied: 'PC entry address copied.',
  pcEntryLinkLabel: 'Access link (open it directly — no pairing code)',
  pcGenerateLink: 'Create access link', pcCopyLink: 'Copy access link', pcGeneratingLink: 'Creating the access link…',
  pcRegenerateLink: 'Regenerate link',
  pcAppKeyLabel: 'Pairing code (fallback — paste it into the entry page)',
  pcLinkReady: 'Access link copied. It does not expire, so your friend can open it any time.',
  pcLinkDurable: 'The link stays valid and needs no pairing code. Regenerating it makes the old link stop working immediately.',
  pcLinkRegenerated: 'A new access link was created and copied; the previous link no longer works.',
  pcCopyKey: 'Copy code', pcKeyCopied: 'Pairing code copied.',
  pcDownloadPackage: 'Download PC installer', pcPreparingPackage: 'Preparing the installer…', pcPackageReady: 'The installer download started. Send the archive to your friend.',
  pcPackageFailed: 'Download failed: {error}', pcChannelUnavailable: 'That channel is unavailable right now. Turn it on first.', pcInfoFailed: 'Could not read the PC entry details: {error}',
  pcDownloadCertificate: 'Download the pairing certificate', pcCertificateNote: 'The PC must trust this certificate before the first connection.',
  pcStepOpen: 'Open the entry link above in Edge or Chrome on the PC.', pcStepInstall: 'Choose “Install” in the address bar, or “Install as app” in the browser menu.',
  pcStepLaunch: 'Launch it from the desktop or Start menu afterwards; no need to type the address again.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.it, {
  pc: 'PC', pcAccess: 'Accesso PC',
  pcIntro: 'Consegna DSH a un amico su PC Windows: invia il link di accesso, lo apre in Edge o Chrome e lo installa come app desktop — nessun codice da digitare.',
  pcNoChannels: 'Nessun ingresso PC disponibile. Attiva prima la rete locale o l’accesso remoto.',
  pcCopyUrl: 'Copia', pcCopyUrlAria: 'Copia l’indirizzo PC per {channel}', pcUrlCopied: 'Indirizzo PC copiato.',
  pcEntryLinkLabel: 'Link di accesso (aprilo direttamente, senza codice)',
  pcGenerateLink: 'Crea link di accesso', pcCopyLink: 'Copia link di accesso', pcGeneratingLink: 'Creazione del link di accesso…',
  pcRegenerateLink: 'Rigenera link',
  pcAppKeyLabel: 'Codice di abbinamento (alternativa: incollalo nella pagina di ingresso)',
  pcLinkReady: 'Link di accesso copiato. Non scade: l’amico può aprirlo quando vuole.',
  pcLinkDurable: 'Il link resta valido e non serve alcun codice. Rigenerandolo, il link precedente smette subito di funzionare.',
  pcLinkRegenerated: 'È stato creato e copiato un nuovo link di accesso; il link precedente non funziona più.',
  pcCopyKey: 'Copia codice', pcKeyCopied: 'Codice di abbinamento copiato.',
  pcDownloadPackage: 'Scarica il pacchetto PC', pcPreparingPackage: 'Preparazione del pacchetto…', pcPackageReady: 'Download del pacchetto avviato. Invia l’archivio all’amico.',
  pcPackageFailed: 'Download non riuscito: {error}', pcChannelUnavailable: 'Questo canale non è disponibile. Attivalo prima.', pcInfoFailed: 'Impossibile leggere i dati dell’ingresso PC: {error}',
  pcDownloadCertificate: 'Scarica il certificato di abbinamento', pcCertificateNote: 'Il PC deve considerare attendibile questo certificato prima della prima connessione.',
  pcStepOpen: 'Apri il link qui sopra in Edge o Chrome sul PC.', pcStepInstall: 'Scegli «Installa» nella barra degli indirizzi oppure «Installa come app» nel menu del browser.',
  pcStepLaunch: 'Avvialo dal desktop o dal menu Start: non serve reinserire l’indirizzo.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.zh, {
  pc: 'PC 端', pcAccess: '电脑端访问',
  pcIntro: '把电脑端交给使用 Windows 的朋友：把访问链接发给对方，对方在 Edge 或 Chrome 中打开并安装为桌面应用即可，无需配对码。',
  pcNoChannels: '当前没有可用的电脑端入口，请先开启局域网访问或远程访问。',
  pcCopyUrl: '复制', pcCopyUrlAria: '复制{channel}电脑端地址', pcUrlCopied: '电脑端地址已复制。',
  pcEntryLinkLabel: '访问链接（直接打开，无需配对码）',
  pcGenerateLink: '生成访问链接', pcCopyLink: '复制访问链接', pcGeneratingLink: '正在生成访问链接…',
  pcRegenerateLink: '重新生成链接',
  pcAppKeyLabel: '配对码（备用，可粘贴到入口页）',
  pcLinkReady: '访问链接已复制。链接长期有效，朋友随时打开都能进入。',
  pcLinkDurable: '链接长期有效，无需配对码；重新生成后旧链接立即失效。',
  pcLinkRegenerated: '已生成新的访问链接并复制，旧链接已失效。',
  pcCopyKey: '复制配对码', pcKeyCopied: '配对码已复制。',
  pcDownloadPackage: '下载 PC 安装包', pcPreparingPackage: '正在准备安装包…', pcPackageReady: '安装包已开始下载，请把压缩包发送给对方。',
  pcPackageFailed: '下载失败：{error}', pcChannelUnavailable: '该通道当前不可用，请先开启。', pcInfoFailed: '无法读取电脑端入口信息：{error}',
  pcDownloadCertificate: '下载配对证书', pcCertificateNote: '首次连接前，请先在电脑上安装并信任该证书。',
  pcStepOpen: '在电脑上用 Edge 或 Chrome 打开上方入口链接。', pcStepInstall: '点击地址栏的「安装」图标，或使用浏览器菜单中的「安装为应用」。',
  pcStepLaunch: '安装后从桌面或开始菜单打开，之后无需再输入地址。',
})

// Trusted SakuraFrp entry (子域绑定 + 自动 HTTPS): the setup card chooses how the
// public entry presents its certificate, and the five failure codes name what to fix.
Object.assign(MOBILE_CONTROL_MESSAGES.en, {
  sakuraEntryMode: 'Public entry certificate',
  sakuraEntryModeTls: 'Plugin certificate (install required)',
  sakuraEntryModeAutoHttps: 'SakuraFrp automatic HTTPS (nothing to install)',
  sakuraBoundDomain: 'Bound subdomain',
  sakuraBoundDomainPlaceholder: 'for example dsh.xxxxx.nyat.app',
  sakuraBoundDomainHint: 'Bind a free subdomain in the SakuraFrp panel and turn on 自动 HTTPS for this tunnel, then paste the subdomain here. The tunnel must stay a TCP tunnel.',
  sakuraTrustedNote: 'Automatic HTTPS is in effect: the public entry presents a publicly trusted certificate, so the friend installs nothing.',
  sakuraUntrustedNote: 'Automatic HTTPS is selected but the public certificate is not verified as trusted yet. Bind a subdomain to this tunnel in the SakuraFrp panel and turn on 自动 HTTPS, then reconnect.',
  sakuraBoundDomainMissing: 'This entry uses automatic HTTPS but no subdomain is bound. Bind one in the SakuraFrp panel, then save it here.',
  sakuraBoundDomainInvalid: 'That subdomain is not a plain host name. Copy the bound subdomain from the SakuraFrp panel, for example dsh.xxxxx.nyat.app.',
  sakuraEntryModeInvalid: 'That entry certificate mode is not supported. Choose the plugin certificate or SakuraFrp automatic HTTPS.',
  sakuraConfigUnsupported: 'The tunnel configuration SakuraFrp returned has no local target the plugin can point at the DSH gateway. Delete and recreate the tunnel, or choose another one.',
  sakuraCertificateUntrusted: 'Automatic HTTPS is not really in effect: the public entry still presents an untrusted certificate. Check that the subdomain binding and 自动 HTTPS are both on in the SakuraFrp panel, then reconnect.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.it, {
  sakuraEntryMode: 'Certificato dell’ingresso pubblico',
  sakuraEntryModeTls: 'Certificato del plugin (da installare)',
  sakuraEntryModeAutoHttps: 'HTTPS automatico SakuraFrp (nulla da installare)',
  sakuraBoundDomain: 'Sottodominio associato',
  sakuraBoundDomainPlaceholder: 'per esempio dsh.xxxxx.nyat.app',
  sakuraBoundDomainHint: 'Associa un sottodominio gratuito nel pannello SakuraFrp e attiva 自动 HTTPS per questo tunnel, poi incolla qui il sottodominio. Il tunnel deve restare di tipo TCP.',
  sakuraTrustedNote: 'L’HTTPS automatico è attivo: l’ingresso pubblico presenta un certificato pubblico attendibile, quindi l’amico non installa nulla.',
  sakuraUntrustedNote: 'Hai scelto l’HTTPS automatico, ma il certificato pubblico non risulta ancora attendibile. Associa un sottodominio a questo tunnel nel pannello SakuraFrp, attiva 自动 HTTPS e riconnettiti.',
  sakuraBoundDomainMissing: 'Questo ingresso usa l’HTTPS automatico ma non ha un sottodominio associato. Associalo nel pannello SakuraFrp e salvalo qui.',
  sakuraBoundDomainInvalid: 'Questo sottodominio non è un nome host valido. Copia il sottodominio associato dal pannello SakuraFrp, per esempio dsh.xxxxx.nyat.app.',
  sakuraEntryModeInvalid: 'Questa modalità di certificato non è supportata. Scegli il certificato del plugin o l’HTTPS automatico SakuraFrp.',
  sakuraConfigUnsupported: 'La configurazione restituita da SakuraFrp non espone una destinazione locale a cui il plugin possa puntare il gateway DSH. Elimina e ricrea il tunnel, oppure scegline un altro.',
  sakuraCertificateUntrusted: 'L’HTTPS automatico non è realmente attivo: l’ingresso pubblico presenta ancora un certificato non attendibile. Verifica che l’associazione del sottodominio e 自动 HTTPS siano entrambi attivi nel pannello SakuraFrp, poi riconnettiti.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.zh, {
  sakuraEntryMode: '公网入口证书',
  sakuraEntryModeTls: '插件自签证书（需在电脑上安装）',
  sakuraEntryModeAutoHttps: 'SakuraFrp 自动 HTTPS（无需安装）',
  sakuraBoundDomain: '已绑定的子域名',
  sakuraBoundDomainPlaceholder: '例如 dsh.xxxxx.nyat.app',
  sakuraBoundDomainHint: '在 SakuraFrp 面板为这条隧道绑定一个免费子域名并开启「自动 HTTPS」，然后把子域名填到这里。隧道类型仍需是 TCP。',
  sakuraTrustedNote: '自动 HTTPS 已生效：公网入口出示的是公开受信任的证书，朋友无需安装任何证书。',
  sakuraUntrustedNote: '已选择自动 HTTPS，但公网证书尚未验证为受信任。请在 SakuraFrp 面板为这条隧道绑定子域名并开启「自动 HTTPS」，然后重新连接。',
  sakuraBoundDomainMissing: '该入口使用自动 HTTPS，但还没有绑定子域名。请先在 SakuraFrp 面板绑定，再到这里保存。',
  sakuraBoundDomainInvalid: '这个子域名不是合法的纯主机名。请从 SakuraFrp 面板复制绑定的子域名，例如 dsh.xxxxx.nyat.app。',
  sakuraEntryModeInvalid: '不支持这种入口证书模式。请选择插件自签证书或 SakuraFrp 自动 HTTPS。',
  sakuraConfigUnsupported: 'SakuraFrp 返回的隧道配置里没有可供插件指向 DSH 网关的本机目标。请删除后重建该隧道，或改选其他隧道。',
  sakuraCertificateUntrusted: '自动 HTTPS 实际没有生效：公网入口仍在出示不受信任的证书。请确认该隧道已同时开启子域名绑定与「自动 HTTPS」，然后重新连接。',
})
