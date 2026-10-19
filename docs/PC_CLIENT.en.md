# PC client (a Windows browser)

[中文指南](PC_CLIENT.md)

The PC client lets a friend use the DSH on your computer from their own Windows browser instead of a second application: the interface is DSH's own web UI, served by the plugin's Mobile Access gateway. The friend installs no DSH, no Node.js and no client program — only unzips a small package you send them and opens the access link you send them.

| | Phone | PC |
| --- | --- | --- |
| Client | Android app or a mobile browser | The friend's Windows browser (Edge, Chrome, …) |
| Interface | Dedicated touch layout | DSH's own desktop web UI |
| Installation | Optional APK install | Unzip the package and run the launcher; no installer |
| Customization layer | `mobile.css` / `mobile.js` | `desktop.css` / `desktop.js` |

The PC entry is always `<mobile-access address>/mobile-access/pc`, independent of the pairing window and available at any time; the phone pairing page (`/mobile-access/pair`) exists only while a pairing window is open. PC and phone share the same device pairing, Sessions and revocation.

## What it is

- **Not a second application**: there is no separate PC client program. It opens the same DSH web UI, showing the same Sessions, Workspaces, messages and tools as the computer.
- **The entry is always available**: the PC entry page does not depend on the pairing window, so the friend can open it first to review the certificate and installation steps, then open the access link the owner sent; that link never expires and works whenever it is opened.
- **Installable as a desktop app**: the entry page provides a Web App Manifest and a pass-through Service Worker that does not cache DSH content; a supporting browser can install it as a standalone-window desktop app.
- **Same authority as a phone**: a paired PC is a trusted device, exactly like a paired phone, and can operate DSH on the computer.

The friend's computer must be able to reach the entry address: the local network requires both of you on the same network, and a friend outside it needs a remote channel enabled first.

## On the owner's computer: prepare and share

1. Open **Mobile Access** in the lower-left corner of DSH and enable the channel you need: **Local network** (simplest when the friend shares your network) or **Remote** (when the friend is outside it). The PC client reuses these channels and adds no listening port.
2. Switch to the **PC** tab, which lists the available entry addresses (local network and remote) with copy buttons.
3. Choose **Create access link** (once the channel already holds one, the button reads **Copy access link**): the panel creates an access link and copies it to the clipboard, shows it in the **Access link** row and shows the app key (shaped like `dsh1.…` or `dsh2.…`) in the **Pairing code (fallback)** row. The link never expires and can be reused; choose **Regenerate link** to replace it, and the old link stops working immediately.
4. Choose **Download PC installer** to get `dsh-mobile-pc.zip`; when the entry uses the plugin's private CA, the tab also offers a certificate download link and short desktop-app instructions.
5. Send the package and the access link to the friend. The friend opens the link and is signed in, with no pairing code to type; the same link can serve several computers and never expires. The **Pairing code (fallback)** row is kept for the phone flow and for manual entry, and it is still a short-lived, single-use credential valid for 5 minutes by default.

> The package contains no secret: only instructions, the certificate when needed, and launcher scripts. The access link is itself a credential, so send it only to people you trust; send the fallback pairing code separately, do not put it in a file name, and do not keep it long-term.

Whether an entry needs a certificate depends on the channel: a cloudflared named tunnel uses Cloudflare's edge certificate and a SakuraFrp tunnel bound to a subdomain with 自动 HTTPS uses natfrp's public certificate, so neither has a certificate step; local-network and SakuraFrp default (`tls`) entries use the plugin's own private CA, so the package carries the certificate and its trust script. See [why a certificate is still needed](#why-a-certificate-is-still-needed) for the reason.

## On the friend's PC: open the client

1. **Unzip**: extract `dsh-mobile-pc.zip` into any directory (for example `dsh-mobile-pc` on the Desktop). Do not open a single file from inside the archive: the launcher needs the certificate and instructions in the same directory.
2. **Trust the certificate (only when required)**: when the package contains `1-trust-certificate.cmd` and `dsh-mobile-ca.cer`, double-click `1-trust-certificate.cmd` and confirm the prompt. It uses Windows' own `certutil` to add the certificate to the current user's Trusted Root Certification Authorities, needs no administrator rights, and changes nothing else on the system. When Windows shows "Windows protected your PC", choose More info, then Run anyway; if the script fails, right-click it and choose Run as administrator. A remote entry with a publicly trusted certificate has no such file; skip this step.
3. **Run the launcher**: double-click `2-open-dsh.cmd`. When Edge or Chrome is found, it opens the PC entry page in an app window; otherwise the default browser opens it. The friend can also double-click `open-dsh.url` or open the entry address directly in a browser.
4. **Open the access link**: open the link the owner sent in Edge or Chrome; the entry page signs this computer in with the key inside the link, so there is no pairing code to type, and it then moves to DSH while the browser remembers this computer. Only when the owner sent a short-lived pairing code instead of a link does the **Pairing code (fallback)** form on the entry page need filling in: that code is valid for 5 minutes by default, single use, and the field accepts the code, the app key (`dsh1.<instance>.<code>`) or the whole entry link.
5. **Optional: install as a desktop app**: a supporting browser shows an **Install as desktop app** button on the entry page (the browser menu's Apps → Install this site as an app does the same). The install adds a desktop or Start-menu entry that opens DSH directly at the same address instead of the entry page; it does not work offline and cannot open while the computer is unreachable.

A friend who received only the access link can follow the same path: when the entry uses the plugin's private CA, choose **Download the certificate** on the entry page (the browser first warns that the address is not secure, which is expected), double-click the downloaded certificate file, close and reopen the tab, then open that access link again; an entry with a publicly trusted certificate (a cloudflared named tunnel or SakuraFrp 自动 HTTPS) skips this step.

Package contents:

| File | Purpose |
| --- | --- |
| `README-zh.txt` / `README-en.txt` / `README-it.txt` | The steps above, in the browser's language when the package was downloaded, UTF-8 encoded |
| `1-trust-certificate.cmd`, `dsh-mobile-ca.cer` | Provided only when the entry uses the plugin's private CA (neither a cloudflared named tunnel nor SakuraFrp 自动 HTTPS provides it) |
| `2-open-dsh.cmd` | Opens the PC entry page, preferring an Edge / Chrome app window |
| `open-dsh.url` | An Internet shortcut to the entry address |

## Why a code is rejected

- **The access link never expires**: it stays valid and is not single use — the same link can sign in several computers, until you choose **Regenerate link** in the panel; after that every previously copied link stops working immediately.
- **The fallback pairing code does expire**: it is valid for 5 minutes by default (the `pairingTtlMs` plugin option, settable from 10 seconds to 15 minutes) and stops working as soon as it is used once, so a second device, or a second browser on the same computer, needs a freshly generated one.
- **Opening the same link again**: on a remote (HTTPS) entry, when this computer already paired and its device cookie is still in the browser, opening the link again refreshes that session instead of adding a device; a local-network (plain HTTP) entry has no readable device binding, so a repeat open can still add a device, and the extra entry can be revoked from the device list.
- **Filling the field by hand**: it accepts the raw code, the app key (`dsh1.<instance>.<code>`, or `dsh2.…` for a self-signed remote entry) or the whole entry link — pasting the link is enough.
- When pairing is rejected, the page distinguishes four cases:
  - **The code is invalid, expired or already used** (401): ask the computer for a newly generated code.
  - **The gateway rejected the source of this request** (403): this is not a code problem; make sure this computer and the host are on the same local network, or use the remote entry or the correct link address.
  - **Too many attempts** (429): wait a moment and try again.
  - **The pairing window is closed** (404): ask the computer for a new code.

## Why a certificate is still needed

A browser only trusts certificates it recognises, so whether a certificate step is needed depends on whose certificate the entry presents:

| Channel | Certificate on the public entry | Certificate step |
| --- | --- | --- |
| cloudflared named tunnel | Cloudflare's edge certificate, already trusted by the browser | Not needed; the package contains no certificate |
| SakuraFrp + subdomain binding + 自动 HTTPS | The public certificate natfrp issues for the bound subdomain | Not needed; the package contains no certificate |
| SakuraFrp default mode (`tls`) | The plugin terminates TLS locally with its private CA, so the entry presents that self-signed certificate | Needed; the package ships `1-trust-certificate.cmd` and `dsh-mobile-ca.cer` |
| Local network entry | The plugin's private CA as well | Needed; install it from the entry page or the package |

SakuraFrp's default mode (`tls`) is a raw TCP tunnel: the plugin terminates TLS locally with its private CA, the public entry is the node domain or IP plus the remote port, and the browser sees the plugin's self-signed certificate and warns first — `1-trust-certificate.cmd` in the package exists for exactly that case.

**Making a SakuraFrp entry need no certificate (subdomain binding + 自动 HTTPS)**: bind the tunnel to a free subdomain in the SakuraFrp panel and leave 「自动 HTTPS」 on 「自动」. frpc then loads the certificate natfrp issued for that subdomain and terminates TLS itself, forwarding plaintext HTTP to the local plugin; the public entry becomes `https://<boundDomain>:<remotePort>` (the port is omitted when the remote port is 443), the browser trusts it directly, the friend installs no certificate, and the package ships none. Under **Mobile Access → Remote** in the SakuraFrp settings, set **Public entry certificate** to **SakuraFrp automatic HTTPS (nothing to install)** and paste the subdomain into **Bound subdomain** (the `entryMode: 'autoHttps'` and `boundDomain` settings); bind the subdomain in the SakuraFrp panel first, because the panel will not save an empty subdomain and points you at the field. The default mode is unchanged, so existing installs are untouched. Two things to watch: keep the tunnel type **TCP** — 自动 HTTPS is how frpc forwards, not another tunnel type; and keep the local target plain HTTP, which the plugin points at its own gateway automatically.

The plugin reports these states honestly:

- `sakurafrp_bound_domain_missing`: the entry uses 自动 HTTPS but no subdomain is bound (the panel refuses to save that combination and asks you to bind one in the SakuraFrp panel first).
- `sakurafrp_config_unsupported`: the fetched frpc config exposes no local target, so nothing can be forwarded to the local gateway.
- `sakurafrp_certificate_untrusted`: the public entry still does not present a publicly trusted certificate, so 自动 HTTPS is not really in effect (most often because it was enabled without binding a subdomain).

At start-up the plugin performs one real handshake against the public entry using the system trust store: the entry is marked trusted only when that succeeds, and a probe that could not finish (a transient network problem) leaves the tunnel working without the trusted claim.

## PC customization layer

The PC and the phone each have their own customization files, both under `$DSH_HOME/mobile-access/`:

| Client | Stylesheet | Script |
| --- | --- | --- |
| Touch client (phone, tablet) | `mobile.css` | `mobile.js` |
| Non-touch client (PC) | `desktop.css` | `desktop.js` |

- The gateway serves the two files as `/mobile-access/desktop.css` and `/mobile-access/desktop.js`, and only a non-touch browser loads them; a touch browser still loads `mobile.css` / `mobile.js` only. The two layers are mutually exclusive per client and never apply together.
- The decision uses the browser's reported primary input (mouse, trackpad or touchscreen), not the operating system: a Windows computer with a touchscreen still uses the PC layer when its primary input is reported as a mouse or trackpad.
- A script mounts PC-only content with `window.dshMobile.registerDesktop(({ document, window, request, root }) => cleanup)`: `root` is the mount node, `request(path, init)` makes an authenticated same-origin request, and the returned cleanup function runs on reload or teardown.
- After you save `desktop.css` or `desktop.js`, the PC page applies it within seconds without restarting DSH; periodic checks remain as a fallback while the page is hidden or disconnected. Deleting the two files restores the built-in default appearance, with no placeholder needed.
- Edit the two files directly, or ask the agent to change files in the same directory from a DSH conversation with `/mobile <what you want>`; PC customization does not affect the phone layer.
- Keep changes inside `$DSH_HOME/mobile-access/` and never modify DeepSeek Harness source.

## Security boundary

- **Certificate**: local-network and SakuraFrp default (`tls`) entries use the plugin's own private CA, and the browser must trust it first; otherwise it shows a "not secure" warning and a desktop-app install cannot start. `1-trust-certificate.cmd` in the package adds `dsh-mobile-ca.cer` to the current user's root store only, writes nothing system-wide, and needs no administrator rights. A cloudflared named tunnel uses Cloudflare's edge certificate, and a SakuraFrp tunnel bound to a subdomain with 自动 HTTPS uses natfrp's public certificate, so neither needs this step; see the [named tunnel guide](CLOUDFLARE_TUNNEL.en.md) for that setup, and [why a certificate is still needed](#why-a-certificate-is-still-needed) for the per-channel difference.
- **The access link stays valid**: it never expires, which makes it more convenient than a code and also more important to look after; **Regenerate link** in the panel makes every previously copied link stop working immediately. Only the **Pairing code (fallback)** is short-lived and single use, and [why a code is rejected](#why-a-code-is-rejected) lists the details.
- **Both the link and the code are credentials**: anyone who receives the access link (or the fallback pairing code) can pair their own device to your DSH. Send it only to people you trust, ideally through a private channel; the package contains neither. Regenerating the link retires every old link at once and cannot retire just one of them; to revoke a single device, use the device list.
- **A PC is a trusted device**: like a phone, a paired PC can operate DSH on the computer and must be treated as fully trusted. When the friend's computer no longer needs access, open the paired-device list for that channel under **Mobile Access** on the computer (**Manage paired devices** for the local network, **Manage remote devices** for remote access) and revoke it; revocation stops its access immediately and its old token then fails.
- **Reachable only while you enable it**: the mobile gateway listens only while a channel is on; with local network and remote access off, even paired devices cannot connect.

See [SECURITY.md](../SECURITY.md) for the wider model.

## Known limits

- **The launcher scripts are Windows-only**: `1-trust-certificate.cmd`, `2-open-dsh.cmd` and `open-dsh.url` are Windows batch files and an Internet shortcut. A macOS or Linux friend can open the entry address in a browser, but certificate trust and the app window are manual steps; the plugin ships no script for them.
- **A desktop-app install needs browser-trusted HTTPS**: Chromium's install entry and its Service Worker both require a secure context; while the certificate is untrusted, or after a certificate warning is bypassed, no install button appears. To use the desktop app, trust the certificate first or use a remote entry with a publicly trusted certificate.
- **It is not an offline app**: the installed desktop app still loads content from your computer and does not cache DSH pages; it cannot be used while the computer is offline, the channel is off, or the device is revoked.
- **The Android app is unaffected**: the PC client changes neither the app's protocol nor its pairing flow; existing app pairings need no rebuild, and the app keeps working after a plugin update.
- The PC client does not modify DeepSeek Harness source, and the friend installs neither DSH nor Node.js.
