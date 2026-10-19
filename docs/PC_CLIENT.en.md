# PC client (a Windows browser)

[中文指南](PC_CLIENT.md)

The PC client lets a friend use the DSH on your computer from their own Windows browser instead of a second application: the interface is DSH's own web UI, served by the plugin's Mobile Access gateway. The friend installs no DSH, no Node.js and no client program — only unzips a small package you send them.

| | Phone | PC |
| --- | --- | --- |
| Client | Android app or a mobile browser | The friend's Windows browser (Edge, Chrome, …) |
| Interface | Dedicated touch layout | DSH's own desktop web UI |
| Installation | Optional APK install | Unzip the package and run the launcher; no installer |
| Customization layer | `mobile.css` / `mobile.js` | `desktop.css` / `desktop.js` |

The PC entry is always `<mobile-access address>/mobile-access/pc`, independent of the pairing window and available at any time; the phone pairing page (`/mobile-access/pair`) exists only while a pairing window is open. PC and phone share the same device pairing, Sessions and revocation.

## What it is

- **Not a second application**: there is no separate PC client program. It opens the same DSH web UI, showing the same Sessions, Workspaces, messages and tools as the computer.
- **The entry is always available**: the PC entry page does not depend on the pairing window, so the friend can open it first to review the certificate and installation steps, then enter the pairing code.
- **Installable as a desktop app**: the entry page provides a Web App Manifest and a pass-through Service Worker that does not cache DSH content; a supporting browser can install it as a standalone-window desktop app.
- **Same authority as a phone**: a paired PC is a trusted device, exactly like a paired phone, and can operate DSH on the computer.

The friend's computer must be able to reach the entry address: the local network requires both of you on the same network, and a friend outside it needs a remote channel enabled first.

## On the owner's computer: prepare and share

1. Open **Mobile Access** in the lower-left corner of DSH and enable the channel you need: **Local network** (simplest when the friend shares your network) or **Remote** (when the friend is outside it). The PC client reuses these channels and adds no listening port.
2. Switch to the **PC** tab, which lists the available entry addresses (local network and remote) with copy buttons.
3. Choose **Generate pairing code**: this opens a time-limited pairing window and shows the pairing code (the app key, shaped like `dsh1.…` or `dsh2.…`) and the PC entry link.
4. Choose **Download PC installer** to get `dsh-mobile-pc.zip`; when the entry uses the plugin's private CA, the tab also offers a certificate download link and short desktop-app instructions.
5. Send the package and the pairing code to the friend. The code is a short-lived credential, so the friend must use it inside its window; generate a fresh one when it expires. You can also send the **PC entry link** directly (the code is in the link's `#` fragment), and the friend does not have to type it.

> The package contains no secret: only instructions, the certificate when needed, and launcher scripts. Send the pairing code separately, do not put it in a file name, and do not keep it long-term.

When the entry uses the plugin's private CA (local network and self-signed remote entries), the package carries the certificate and its trust script; a remote entry with a publicly trusted certificate (a Cloudflare named tunnel, for example) has neither.

## On the friend's PC: open the client

1. **Unzip**: extract `dsh-mobile-pc.zip` into any directory (for example `dsh-mobile-pc` on the Desktop). Do not open a single file from inside the archive: the launcher needs the certificate and instructions in the same directory.
2. **Trust the certificate (only when required)**: when the package contains `1-trust-certificate.cmd` and `dsh-mobile-ca.cer`, double-click `1-trust-certificate.cmd` and confirm the prompt. It uses Windows' own `certutil` to add the certificate to the current user's Trusted Root Certification Authorities, needs no administrator rights, and changes nothing else on the system. When Windows shows "Windows protected your PC", choose More info, then Run anyway; if the script fails, right-click it and choose Run as administrator. A remote entry with a publicly trusted certificate has no such file; skip this step.
3. **Run the launcher**: double-click `2-open-dsh.cmd`. When Edge or Chrome is found, it opens the PC entry page in an app window; otherwise the default browser opens it. The friend can also double-click `open-dsh.url` or open the entry address directly in a browser.
4. **Enter the pairing code**: the entry page first lists the steps; type the code into the pairing form, optionally give the computer a recognizable device name, and submit. The pairing window is 120 seconds by default; when the page reports that the code is no longer valid, ask the computer for a freshly generated one. After pairing, the page moves to DSH and the browser remembers this computer.
5. **Optional: install as a desktop app**: a supporting browser shows an **Install as desktop app** button on the entry page (the browser menu's Apps → Install this site as an app does the same). The install adds a desktop or Start-menu entry that opens DSH directly at the same address instead of the entry page; it does not work offline and cannot open while the computer is unreachable.

A friend who received only the entry link can follow the same path: on the entry page choose **Download the certificate** (the browser first warns that the address is not secure, which is expected), double-click the downloaded certificate file, close and reopen the tab, then enter the pairing code.

Package contents:

| File | Purpose |
| --- | --- |
| `README-zh.txt` / `README-en.txt` / `README-it.txt` | The steps above, in the browser's language when the package was downloaded, UTF-8 encoded |
| `1-trust-certificate.cmd`, `dsh-mobile-ca.cer` | Provided only when the entry uses the plugin's private CA |
| `2-open-dsh.cmd` | Opens the PC entry page, preferring an Edge / Chrome app window |
| `open-dsh.url` | An Internet shortcut to the entry address |

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

- **Certificate**: local-network and self-signed remote entries use the plugin's own private CA, and the browser must trust it first; otherwise it shows a "not secure" warning and a desktop-app install cannot start. `1-trust-certificate.cmd` in the package adds `dsh-mobile-ca.cer` to the current user's root store only, writes nothing system-wide, and needs no administrator rights. A remote entry with a publicly trusted certificate (a Cloudflare named tunnel, for example) skips this step; see the [named tunnel guide](CLOUDFLARE_TUNNEL.en.md) for that setup.
- **The pairing window is short**: choosing **Generate pairing code** opens a single-use pairing window (120 seconds by default, adjustable in the plugin configuration between 10 seconds and 10 minutes). Once it closes, the pairing page and the code stop working, while already paired devices are unaffected; the window can be used successfully only once.
- **The pairing code is a credential**: anyone holding it can pair their own device to your DSH. Send it only to people you know, ideally on its own, and never inside the package.
- **A PC is a trusted device**: like a phone, a paired PC can operate DSH on the computer and must be treated as fully trusted. When the friend's computer no longer needs access, open the paired-device list for that channel under **Mobile Access** on the computer (**Manage paired devices** for the local network, **Manage remote devices** for remote access) and revoke it; revocation stops its access immediately and its old token then fails.
- **Reachable only while you enable it**: the mobile gateway listens only while a channel is on; with local network and remote access off, even paired devices cannot connect.

See [SECURITY.md](../SECURITY.md) for the wider model.

## Known limits

- **The launcher scripts are Windows-only**: `1-trust-certificate.cmd`, `2-open-dsh.cmd` and `open-dsh.url` are Windows batch files and an Internet shortcut. A macOS or Linux friend can open the entry address in a browser, but certificate trust and the app window are manual steps; the plugin ships no script for them.
- **A desktop-app install needs browser-trusted HTTPS**: Chromium's install entry and its Service Worker both require a secure context; while the certificate is untrusted, or after a certificate warning is bypassed, no install button appears. To use the desktop app, trust the certificate first or use a remote entry with a publicly trusted certificate.
- **It is not an offline app**: the installed desktop app still loads content from your computer and does not cache DSH pages; it cannot be used while the computer is offline, the channel is off, or the device is revoked.
- **The Android app is unaffected**: the PC client changes neither the app's protocol nor its pairing flow; existing app pairings need no rebuild, and the app keeps working after a plugin update.
- The PC client does not modify DeepSeek Harness source, and the friend installs neither DSH nor Node.js.
