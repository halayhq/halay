#if SELFTEST
import AppKit
import WebKit
import UserNotifications
import ServiceManagement

/// Checks of the glue that can't be unit tested, run inside the real app against a spare halay server:
///   macos/build.sh --selftest && macos/build/halay-selftest.app/Contents/MacOS/halay --data-dir <spare data dir>
/// Never part of the shipped app (build.sh compiles it only with --selftest). Events are synthesized (key equivalents through
/// the main menu, mouse clicks through the window), so a real user gesture reaches the page, e.g. for the file chooser.
@MainActor
enum SelfTest {
    static var fails = 0
    /// stdout, and `--log <file>` too (a launch through LaunchServices has no terminal)
    static func out(_ line: String) {
        print(line)
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--log"), i + 1 < a.count, let h = FileHandle(forWritingAtPath: a[i + 1]) ?? { FileManager.default.createFile(atPath: a[i + 1], contents: nil); return FileHandle(forWritingAtPath: a[i + 1]) }() else { return }
        h.seekToEndOfFile(); h.write((line + "\n").data(using: .utf8)!); try? h.close()
    }
    static func ok(_ cond: Bool, _ msg: String) { out((cond ? "PASS " : "FAIL ") + msg); if !cond { fails += 1 } }
    static func skip(_ msg: String) { out("SKIP " + msg) }
    static func sleep(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1e9)) }

    static func js(_ wv: WKWebView, _ code: String) async -> Any? {
        do { return try await wv.callAsyncJavaScript(code, arguments: [:], in: nil, contentWorld: .page) } catch { out("js error: \(error)"); return nil }
    }
    static func jsString(_ wv: WKWebView, _ code: String) async -> String { (await js(wv, code)).map { "\($0)" } ?? "" }
    static func waitFor(_ wv: WKWebView, _ cond: String, _ secs: Double = 10) async -> Bool {
        for _ in 0..<Int(secs * 10) { if await js(wv, "return !!(\(cond))") as? Bool == true { return true }; await sleep(0.1) }
        return false
    }

    static func key(_ chars: String, _ mods: NSEvent.ModifierFlags = .command, window: NSWindow) -> Bool {
        let ev = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: 0)!
        return NSApp.mainMenu?.performKeyEquivalent(with: ev) ?? false
    }

    /// a click at the centre of a page element, as the user would make it
    static func click(_ selector: String, _ wv: WKWebView, _ window: NSWindow) async -> Bool {
        guard let rect = await js(wv, "const r = document.querySelector('\(selector)')?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null") as? [Double], rect.count == 2 else { return false }
        let h = wv.frame.height
        let p = NSPoint(x: rect[0], y: h - rect[1])   // page coordinates are top-left, the window's bottom-left
        for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let ev = NSEvent.mouseEvent(with: t, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            window.sendEvent(ev)
        }
        return true
    }

    static func run(_ app: AppDelegate) async {
        let loc = Locator.locate()
        ok(loc.running, "found the running spare server via runs/server.json (port \(loc.port))")

        // ---- a launch without flags (login item, Spotlight) finds the folder the last `halay app` used
        let suite = UserDefaults(suiteName: "app.halay.mac.selftest.locator")!
        suite.removePersistentDomain(forName: "app.halay.mac.selftest.locator")
        _ = Locator.locate(args: ["halay", "--data-dir", "/tmp/halay-remembered", "--port", "4999"], env: [:], defaults: suite)
        let bare = Locator.locate(args: ["halay"], env: [:], defaults: suite)
        ok(bare.dataDir.path == "/tmp/halay-remembered" && bare.port == 4999, "no flags: the folder and port of the last launch are used (\(bare.dataDir.path):\(bare.port))")
        ok(Locator.locate(args: ["halay"], env: ["HALAY_HOME": "/tmp/other"], defaults: suite).dataDir.path == "/tmp/other", "HALAY_HOME still wins over the remembered folder")
        suite.removePersistentDomain(forName: "app.halay.mac.selftest.locator")
        // ---- Settings: what is typed is checked, and a choice wins over the flags
        ok({ if case .success(let u?) = AppSettings.parseServerURL(" mac-mini.local:4777/ ") { return u.absoluteString == "http://mac-mini.local:4777" }; return false }(), "server address: a bare host:port becomes http://host:port")
        ok({ if case .success(let u?) = AppSettings.parseServerURL("HTTPS://halay.example.com/a/b?x=1") { return u.absoluteString == "https://halay.example.com" }; return false }(), "server address: path and query are dropped")
        ok({ if case .success(nil) = AppSettings.parseServerURL("  ") { return true }; return false }(), "server address: empty means automatic")
        ok({ for bad in ["ftp://x", "http://u:p@h", "http://"] { if case .success = AppSettings.parseServerURL(bad) { return false } }; return true }(), "server address: other schemes, credentials and no host are refused")
        ok({ if case .success(let d?) = AppSettings.parseDataDir("~/x/../.halay") { return d == FileManager.default.homeDirectoryForCurrentUser.path + "/.halay" }; return false }(), "data folder: ~ is expanded and the path tidied")
        ok({ if case .failure = AppSettings.parseDataDir("relative/dir") { return true }; return false }(), "data folder: a relative path is refused")
        let cs = UserDefaults(suiteName: "app.halay.mac.selftest.settings")!
        cs.removePersistentDomain(forName: "app.halay.mac.selftest.settings")
        let flagged = Locator.locate(args: ["halay", "--data-dir", "/tmp/from-flag", "--port", "4999"], env: [:], defaults: cs)
        ok(flagged.dataDir.path == "/tmp/from-flag" && flagged.port == 4999 && flagged.customURL == nil, "no settings: the flags are used")
        cs.set("/tmp/from-settings", forKey: AppSettings.dataDirKey); cs.set("https://halay.example.com", forKey: AppSettings.serverURLKey)
        let chosen = Locator.locate(args: ["halay", "--data-dir", "/tmp/from-flag", "--port", "4999"], env: ["HALAY_HOME": "/tmp/env"], defaults: cs)
        ok(chosen.dataDir.path == "/tmp/from-settings" && chosen.port == 4777 && chosen.customURL?.absoluteString == "https://halay.example.com" && chosen.candidates.map(\.absoluteString) == ["https://halay.example.com"], "settings win over the flags and HALAY_HOME; another server is the only candidate")
        ok(Locator.locate(args: ["halay"], env: [:], defaults: cs, ignoreSettings: true).customURL == nil, "ignoreSettings gives the automatic location")
        // the window: shows what is stored, refuses bad input, saves good input and tells the app
        let sw = SettingsWindow(client: app.client, defaults: cs)
        var saved = 0; sw.onSave = { saved += 1 }
        sw.show()
        ok(sw.another.state == .on && sw.urlField.stringValue == "https://halay.example.com" && sw.dirField.stringValue == "/tmp/from-settings", "Settings shows the stored server and data folder")
        sw.urlField.stringValue = "ftp://nope"; sw.save()
        ok(saved == 0 && cs.string(forKey: AppSettings.serverURLKey) == "https://halay.example.com" && sw.status.stringValue.contains("http"), "Settings: a bad address is refused with a message, nothing is saved")
        sw.urlField.stringValue = "other.local:4000"; sw.dirField.stringValue = "~/halay-x"; sw.save()
        ok(saved == 1 && cs.string(forKey: AppSettings.serverURLKey) == "http://other.local:4000" && cs.string(forKey: AppSettings.dataDirKey) == FileManager.default.homeDirectoryForCurrentUser.path + "/halay-x", "Settings: Save stores both, normalised, and calls onSave")
        sw.show(); sw.automatic.performClick(nil); sw.dirField.stringValue = ""; sw.save()
        ok(saved == 2 && cs.string(forKey: AppSettings.serverURLKey) == nil && cs.string(forKey: AppSettings.dataDirKey) == nil, "Settings: This Mac + empty folder removes both choices (automatic)")
        if let dir = ProcessInfo.processInfo.environment["HALAY_SELFTEST_SNAPSHOT"], let v = sw.window?.contentView {
            sw.show(); sw.another.performClick(nil); sw.urlField.stringValue = "mac-mini.local:4777"
            v.layoutSubtreeIfNeeded()
            if let st = v as? NSStackView { for sub in st.arrangedSubviews { out("INFO settings row \(sub.className) y=\(Int(sub.frame.minY)) h=\(Int(sub.frame.height)) x=\(Int(sub.frame.minX)) w=\(Int(sub.frame.width))") }; out("INFO settings window \(sw.window!.frame.size)") }
            // no screen needed: draw the controls into a bitmap, on the window's own colour
            if let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                v.cacheDisplay(in: v.bounds, to: rep)
                let img = NSImage(size: v.bounds.size)
                img.lockFocus(); NSColor.windowBackgroundColor.setFill(); NSRect(origin: .zero, size: v.bounds.size).fill(); rep.draw(in: NSRect(origin: .zero, size: v.bounds.size)); img.unlockFocus()
                if let tiff = img.tiffRepresentation { try? NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir + "/settings.png")) }
            }
        }
        sw.window?.close()
        cs.removePersistentDomain(forName: "app.halay.mac.selftest.settings")
        ok(NSApp.windows.filter { $0.isVisible && $0.styleMask.contains(.titled) }.allSatisfy { $0 !== sw.window }, "Settings window closed")

        // registering adds a real login item to this Mac, so only on request (HALAY_SELFTEST_LOGIN=1), and it is removed again
        if ProcessInfo.processInfo.environment["HALAY_SELFTEST_LOGIN"] == "1" {
            let err = LaunchAtLogin.toggle()
            out("INFO register: error=\(err ?? "none") status=\(LaunchAtLogin.status.rawValue) title=\(LaunchAtLogin.title)")
            try? await SMAppService.mainApp.unregister()
            out("INFO after unregister: status=\(LaunchAtLogin.status.rawValue)")
        }
        // registering would add a real login item to this Mac: only read the status
        ok([.notRegistered, .enabled, .requiresApproval, .notFound].contains(LaunchAtLogin.status) && !LaunchAtLogin.title.isEmpty, "Launch at Login status readable (\(LaunchAtLogin.status.rawValue))")

        // ---- status
        let snap = await app.client.snapshot()
        ok(snap.reachable, "status: server reachable at \(snap.base?.absoluteString ?? "-")")
        ok(snap.note == nil, "status: agents read with the local session (note: \(snap.note ?? "none"))")
        out("INFO agents: \(snap.total) total, \(snap.running) running, \(snap.blocked) blocked")

        // ---- notifications before any page exists: the native event stream (EventStream.swift)
        let posted = PostCounter()
        app.notifier.spy = { posted.n += 1; posted.last = $0 }
        ok(app.events.isRunning && app.web.web == nil, "event stream running, no web view yet")
        if let cookie = app.client.cookie, let base = snap.base {
            let h = ["Cookie": "\(cookie.name)=\(cookie.value)", "content-type": "application/json"]
            let made = try? await app.client.send(base, "/api/agents", method: "POST", headers: h, body: try? JSONSerialization.data(withJSONObject: ["cwd": FileManager.default.temporaryDirectory.path, "name": "streamtest"]))
            if let id = (made.flatMap { try? JSONSerialization.jsonObject(with: $0.0) } as? [String: Any])?["id"] as? String {
                _ = try? await app.client.send(base, "/api/agents/\(id)/send", method: "POST", headers: h, body: try? JSONSerialization.data(withJSONObject: ["text": "hi"]))
                for _ in 0..<150 where posted.n == 0 { await sleep(0.1) }
                ok(posted.last.hasPrefix("streamtest · finished|") && posted.last.hasSuffix("|\(id)|/#/a/\(id)"), "an agent finishing a turn raised a notification with no window open: \(posted.last)")
            } else { ok(false, "could not start an agent for the stream test") }
        }
        posted.n = 0; posted.last = ""

        // ---- window opens signed in
        app.web.show()
        guard await waitFor2({ app.web.web != nil }), let wv = app.web.web, let window = app.web.window else { ok(false, "window created"); finish(); return }
        ok(true, "window created")
        ok(await waitFor(wv, "document.readyState === 'complete' && document.querySelector('#main, #list, aside')", 15), "UI loaded")
        ok(await jsString(wv, "return location.pathname + ' ' + !!document.querySelector('#login, .login')") .hasSuffix("false"), "not on the login page (signed in by the local token)")
        ok(await jsString(wv, "return (await fetch('/api/agents')).status") == "200", "the page's own API calls work with the session cookie")
        ok(await jsString(wv, "return navigator.userAgent").contains("HalayShell/1"), "user agent ends with HalayShell/1")
        ok(await jsString(wv, "return window.halayShell && window.halayShell.platform") == "macos", "window.halayShell is set before the page's scripts")

        ok(NSApp.activationPolicy() == .regular && NSApp.mainMenu?.items.map { $0.submenu?.title ?? "" } == ["halay", "File", "Edit", "View", "Window"], "while the window is open the app has a Dock icon and a menu bar (halay, File, Edit, View, Window)")
        out("INFO gap probe: " + (await jsString(wv, "const p = document.createElement('div'); p.style.cssText = 'position:fixed;left:0;top:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'; document.body.append(p); const c = getComputedStyle(p); const r = `safe ${c.paddingTop}/${c.paddingRight}/${c.paddingBottom}/${c.paddingLeft} inner ${innerWidth}x${innerHeight} body ${document.body.getBoundingClientRect().height} main ${document.querySelector('#main').getBoundingClientRect().bottom} side ${document.querySelector('#side').getBoundingClientRect().bottom}`; p.remove(); return r")) + " window content \(window.contentView!.frame.size) layout \(window.contentLayoutRect.size)")
        // ---- the page runs under a transparent title bar
        ok(window.styleMask.contains(.fullSizeContentView) && window.titlebarAppearsTransparent && window.titleVisibility == .hidden && window.title == "halay", "title bar is transparent, the title hidden (still named halay)")
        ok(await jsString(wv, "return document.documentElement.classList.contains('halay-mac') && parseFloat(getComputedStyle(document.querySelector('#side h1')).paddingLeft) >= 80") == "1", "page marks itself halay-mac and leaves room for the window buttons")
        if let close = window.standardWindowButton(.closeButton) {
            let r = close.convert(close.bounds, to: nil), top = window.frame.height - r.midY
            out("INFO close button centre \(Int(r.midX)),\(Int(top)) from the window's top left; title bar \(Int(window.frame.height - window.contentLayoutRect.height)) tall; frame \(window.frame.size) layout \(window.contentLayoutRect) content \(window.contentView!.frame) zoom maxX \(Int(window.standardWindowButton(.zoomButton)!.convert(window.standardWindowButton(.zoomButton)!.bounds, to: nil).maxX))")
            ok(top > 20 && top < 32, "window buttons sit in a ~52pt title bar, centred at \(Int(top))")
        }
        window.setContentSize(NSSize(width: 1281, height: 820)); await sleep(0.5)
        let insets = (await jsString(wv, "return getComputedStyle(document.documentElement).getPropertyValue('--halay-inset') + ' ' + getComputedStyle(document.documentElement).getPropertyValue('--halay-bar')")).split(separator: " ").compactMap { Int($0.dropLast(2)) }
        ok(insets.count == 2 && (80...110).contains(insets[0]) && (44...60).contains(insets[1]), "the page got --halay-inset (right of the buttons) and --halay-bar (title bar height): \(insets)")
        let want = await jsString(wv, "return document.querySelector('meta[name=\"theme-color\"]').content")
        ok(await waitFor2({ window.backgroundColor.usingColorSpace(.sRGB).map { String(format: "#%02x%02x%02x", Int($0.redComponent * 255 + 0.5), Int($0.greenComponent * 255 + 0.5), Int($0.blueComponent * 255 + 0.5)) } == want.lowercased() }), "window colour follows the page's theme colour (\(want))")
        // HALAY_SELFTEST_WIDTHS=516,820: page.png of an agent's chat at each window width (for looking at the responsive layout)
        if let dir = ProcessInfo.processInfo.environment["HALAY_SELFTEST_SNAPSHOT"], let widths = ProcessInfo.processInfo.environment["HALAY_SELFTEST_WIDTHS"] {
            _ = await js(wv, "const a = await (await fetch('/api/agents')).json(); location.hash = '#/a/' + (a.agents || a)[0].id")
            for w in widths.split(separator: ",").compactMap({ Int($0) }) {
                window.setContentSize(NSSize(width: w, height: 700)); await sleep(1.0)
                let cfg = WKSnapshotConfiguration()
                if let img = try? await wv.takeSnapshot(configuration: cfg), let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: "\(dir)/w\(w).png")) }
            }
        }
        if let dir = ProcessInfo.processInfo.environment["HALAY_SELFTEST_SNAPSHOT"] {
            _ = await js(wv, "return 1")
            if let img = try? await wv.takeSnapshot(configuration: nil), let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: dir + "/page.png")) }
        }

        // ---- the window follows the server: a "can't reach halay" note is replaced when the server answers again, and a restarted server's page is loaded again
        app.web.webView(wv, didFailProvisionalNavigation: nil, withError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost))   // what a reload while the server is down ends in
        ok(await waitFor(wv, "document.body && document.body.textContent.includes(\"Can't reach halay\")", 15), "an unreachable server shows the note in the window")
        app.web.serverBack(startedAt: nil)
        ok(await waitFor(wv, "document.readyState === 'complete' && !!document.querySelector('#side')", 15), "…and the server's page comes back when the server is reachable again")
        _ = await js(wv, "window.__marker = 1")
        app.web.serverBack(startedAt: Date().timeIntervalSince1970 * 1000 - 3_600_000)   // started before the page loaded: nothing to do
        await sleep(1.0)
        ok(await jsString(wv, "return window.__marker") == "1", "a server that started before the page loaded doesn't reload it")
        app.web.serverBack(startedAt: Date().timeIntervalSince1970 * 1000 + 5_000)
        ok(await waitFor(wv, "window.__marker === undefined && document.readyState === 'complete' && !!document.querySelector('#side')", 15), "a server that started after the page loaded reloads it")
        // HALAY_SELFTEST_RESTART_CMD: really restart the spare server and see the window reload by itself (the menu's 5 s look finds the new start time)
        if let cmd = ProcessInfo.processInfo.environment["HALAY_SELFTEST_RESTART_CMD"] {
            _ = await js(wv, "window.__marker = 2")
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh"); p.arguments = ["-c", cmd]
            try? p.run(); p.waitUntilExit()
            ok(await waitFor(wv, "window.__marker === undefined && document.readyState === 'complete' && !!document.querySelector('#side')", 40), "after a real server restart the window reloads by itself")
            ok(await jsString(wv, "return location.pathname + ' ' + !!document.querySelector('#login, .login')").hasSuffix("false"), "…and is still signed in")
        }

        // ---- push setting relabelled
        _ = await js(wv, "location.hash = '#/settings'")
        ok(await waitFor(wv, "document.querySelector('#pnote')?.textContent.includes('Mac app')", 10), "Settings: push note says this is the Mac app")
        ok(await jsString(wv, "return document.querySelector('#pbtn').hidden && document.querySelector('#bnotif').hidden") == "1", "Settings: enable/disable push buttons hidden in the app")

        // ---- notifications
        ok(await jsString(wv, "return Notification.permission + ' ' + (await Notification.requestPermission())") == "granted granted", "Notification.permission / requestPermission resolve granted")
        ok(!app.events.isRunning, "event stream stopped once the page runs (no double notifications)")
        _ = await js(wv, "window.__n = new Notification('alpha · done', { body: 'finished', tag: 'abc', data: { url: '/#/settings' } }); window.__clicked = 0; window.__n.onclick = () => { window.__clicked++; }")
        await sleep(0.3)
        ok(posted.n == 1 && posted.last == "alpha · done|finished|abc|/#/settings", "new Notification(...) reached Swift: \(posted.last)")
        let center = UNUserNotificationCenter.current()
        let auth = await center.notificationSettings().authorizationStatus
        out("INFO macOS notification permission status: \(auth.rawValue) (0 = not asked yet, 1 = denied, 2 = allowed)")
        if auth == .authorized {
            await sleep(0.5)
            ok(await center.deliveredNotifications().contains { $0.request.identifier == "tag:abc" }, "a real macOS notification was delivered")
        } else { skip("real notification delivery: macOS notification permission is not granted for the self-test app") }
        _ = await js(wv, "location.hash = '#/'")
        app.web.window?.orderOut(nil)
        app.notifier.onClick?("\(await jsString(wv, "return window.__n._id"))", "/#/settings")
        ok(await waitFor(wv, "window.__clicked === 1", 3), "clicking the notification calls the page's onclick")
        ok(window.isVisible, "…and brings the window back")
        out("INFO active=\(NSApp.isActive) key=\(window.isKeyWindow) screens=\(NSScreen.screens.count) occluded=\(window.occlusionState.contains(.visible) ? "no" : "yes")")

        // the rest needs a screen that is on and unlocked: a locked screen leaves the window occluded and the app inactive,
        // and synthesized events then go nowhere
        for _ in 0..<30 { if window.occlusionState.contains(.visible) { break }; window.makeKeyAndOrderFront(nil); await sleep(0.1) }
        guard window.occlusionState.contains(.visible) else {
            skip("Edit menu, file chooser, external links, Cmd+R / Cmd+W: the window is not visible (screen locked or asleep); run again with the screen on")
            finish(); return
        }

        // ---- Edit menu: copy / paste / select all / undo through the main menu's key equivalents
        _ = await js(wv, "document.body.insertAdjacentHTML('beforeend', '<textarea id=t1 style=\"position:fixed;top:0;left:0;z-index:99999\">hello halay</textarea><textarea id=t2 style=\"position:fixed;top:60px;left:0;z-index:99999\"></textarea>'); document.querySelector('#t1').focus()")
        window.makeFirstResponder(wv)
        NSPasteboard.general.clearContents()
        ok(key("a", window: window), "Cmd+A is handled by the menu")
        ok(key("c", window: window), "Cmd+C is handled by the menu")
        await sleep(0.3)
        ok(NSPasteboard.general.string(forType: .string) == "hello halay", "Cmd+A, Cmd+C: the clipboard has the text (\(NSPasteboard.general.string(forType: .string) ?? "nil"))")
        _ = await js(wv, "document.querySelector('#t2').focus()")
        ok(key("v", window: window), "Cmd+V is handled by the menu")
        ok(await waitFor(wv, "document.querySelector('#t2').value === 'hello halay'", 3), "Cmd+V pastes into another field")
        _ = await js(wv, "document.querySelector('#t2').select()")
        ok(key("x", window: window), "Cmd+X is handled by the menu")
        ok(await waitFor(wv, "document.querySelector('#t2').value === ''", 3), "Cmd+X cuts")
        ok(key("z", window: window), "Cmd+Z is handled by the menu")
        _ = await js(wv, "document.querySelector('#t1').remove(); document.querySelector('#t2').remove()")

        // ---- file chooser
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("halay-selftest-\(getpid()).txt")
        try? "attachment".write(to: tmp, atomically: true, encoding: .utf8)
        var asked = 0
        app.web.openPanelOverride = { asked += 1; return [tmp] }
        _ = await js(wv, "document.body.insertAdjacentHTML('beforeend', '<button id=pick style=\"position:fixed;top:120px;left:0;z-index:99999;width:200px;height:40px\">pick</button><input type=file id=pf hidden>'); document.querySelector('#pick').onclick = () => document.querySelector('#pf').click(); window.__picked = ''; document.querySelector('#pf').addEventListener('change', (e) => { window.__picked = [...e.target.files].map((f) => f.name + ':' + f.size).join(','); })")
        ok(await click("#pick", wv, window), "synthesized a click on a button that opens <input type=file>")
        ok(await waitFor(wv, "window.__picked", 5), "file chooser: runOpenPanelWith was asked (\(asked)x) and the page got the file: \(await jsString(wv, "return window.__picked"))")
        try? FileManager.default.removeItem(at: tmp)

        // ---- external links
        var opened: [URL] = []
        app.web.externalOpenOverride = { opened.append($0) }
        _ = await js(wv, "document.body.insertAdjacentHTML('beforeend', '<a id=ext target=_blank href=\"https://example.com/blank\" style=\"position:fixed;top:200px;left:0;z-index:99999;display:block;width:200px;height:30px\">blank</a><a id=same href=\"https://example.org/self\" style=\"position:fixed;top:260px;left:0;z-index:99999;display:block;width:200px;height:30px\">self</a>')")
        _ = await click("#ext", wv, window)
        await sleep(0.5)
        ok(opened.map(\.absoluteString) == ["https://example.com/blank"], "target=_blank link goes to the default browser: \(opened)")
        _ = await click("#same", wv, window)
        await sleep(0.5)
        ok(opened.last?.absoluteString == "https://example.org/self" && wv.url?.host == snap.base?.host, "a link to another site in the same tab opens in the browser, the window stays on halay (\(wv.url?.absoluteString ?? "-"))")

        // ---- Cmd+R and Cmd+W
        ok(key("r", window: window), "Cmd+R is handled by the menu")
        ok(await waitFor(wv, "document.readyState === 'complete'", 10), "…and the page is back after the reload")
        ok(key("w", window: window), "Cmd+W is handled by the menu")
        await sleep(0.3)
        ok(!window.isVisible, "…and closes the window")
        finish()
    }

    static func waitFor2(_ cond: () -> Bool) async -> Bool {
        for _ in 0..<100 { if cond() { return true }; await sleep(0.1) }
        return false
    }

    static func finish() {
        out("\n\(fails == 0 ? "all checks passed" : "\(fails) failed")")
        exit(fails == 0 ? 0 : 1)
    }
}

final class PostCounter { var n = 0; var last = "" }
#endif
