import AppKit
import WebKit

/// The window with the halay web UI. The window and its web view are made on first use and then kept (closing only hides
/// it), so the page, its live connection and its notifications keep running while the window is closed.
@MainActor
final class WebWindow: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, NSWindowDelegate {
    private let client: ServerClient
    private let notifier: Notifier
    private(set) var window: NSWindow?
    private var webView: WKWebView?
    private var showingError = false      // the window shows the "can't reach halay" note
    private var loadedAt = Date.distantPast   // when the page last finished loading
    private var loadedBase: URL?
    /// test hooks (SelfTest.swift, build.sh --selftest): answer the file chooser without a panel, and see what would open in the browser
    var openPanelOverride: (() -> [URL]?)?
    var externalOpenOverride: ((URL) -> Void)?

    init(client: ServerClient, notifier: Notifier) {
        self.client = client
        self.notifier = notifier
        super.init()
        notifier.onClick = { [weak self] id, url in self?.notificationClicked(id: id, url: url) }
        client.onNewSession = { [weak self] in self?.sessionRenewed() }
    }

    var isVisible: Bool { window?.isVisible ?? false }
    var web: WKWebView? { webView }

    // MARK: open / close

    /// Signs in (if needed), then shows the window. Reports why it can't.
    /// path: where to go once it is open (a notification's target); the app's start page otherwise
    func show(path: String? = nil) {
        Task {
            do {
                let (base, cookie) = try await client.ensureSession()
                let wv = makeWebView()
                if let cookie { await wv.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) }
                if let path, let target = URL(string: path, relativeTo: base) {
                    // a notification's target: the page itself navigates when it is already open (a hash route), else load it
                    if loadedBase != base || wv.url == nil { wv.load(URLRequest(url: target)) } else { wv.callAsyncJavaScript("location.href = url", arguments: ["url": target.absoluteString], in: nil, in: .page) { _ in } }
                    loadedBase = base
                } else if loadedBase != base || wv.url == nil || showingError { loadedBase = base; wv.load(URLRequest(url: base)) }
                reveal()
                notifier.requestAuthorization()
            } catch {
                let alert = NSAlert()
                alert.messageText = "Can't open halay"
                alert.informativeText = "\(error)"
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
    }

    func reveal() {
        guard let window else { return }
        NSApp.setActivationPolicy(.regular)   // an accessory app has no menu bar (File, Edit…) and no Dock icon: it has both while its window is open
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @objc func reload(_ sender: Any?) { webView?.reload() }

    @objc func zoom(_ sender: NSMenuItem) {
        guard let wv = webView else { return }
        wv.pageZoom = sender.tag == 0 ? 1 : min(3, max(0.5, wv.pageZoom + 0.1 * Double(sender.tag)))
    }

    /// the page is about to run: it raises notifications itself from now on (EventStream.swift stops)
    var onWebViewCreated: (() -> Void)?

    private func makeWebView() -> WKWebView {
        if let webView { return webView }
        onWebViewCreated?()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()    // persistent: the page's own settings (theme, drafts) survive
        config.applicationNameForUserAgent = "HalayShell/1"   // also visible to the server in the User-Agent
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: shimSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.add(self, name: "halay")
        config.userContentController = ucc

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        if #available(macOS 13.3, *) { wv.isInspectable = ProcessInfo.processInfo.environment["HALAY_APP_DEBUG"] == "1" }

        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        w.title = "halay"   // not drawn (the page runs under the title bar) but still the name in Mission Control and the Window menu
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        // an (empty) unified toolbar makes the title bar tall and centres the window's buttons in it, level with the page's first row
        let bar = NSToolbar(identifier: "halay.main")
        bar.showsBaselineSeparator = false
        w.toolbar = bar
        w.toolbarStyle = .unified
        w.contentView = wv
        w.contentMinSize = NSSize(width: 520, height: 400)
        w.isReleasedWhenClosed = false
        w.delegate = self
        if !w.setFrameUsingName("halay.main") { w.center() }
        w.setFrameAutosaveName("halay.main")
        window = w
        webView = wv
        return wv
    }

    /// a new session (the old one expired or was reset): give it to the web view and reload so the page stops showing the sign-in
    private func sessionRenewed() {
        guard let wv = webView, let cookie = client.cookie else { return }
        Task {
            await wv.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
            if wv.url != nil { wv.reload() }
        }
    }

    private func notificationClicked(id: String, url: String) {
        // from the event stream (EventStream.swift) there is no page yet: open the window at the notification's target
        guard webView != nil else { return show(path: url.isEmpty ? nil : url) }
        reveal()
        webView?.callAsyncJavaScript("return window.__halayNotificationClicked ? window.__halayNotificationClicked(id, url) : false", arguments: ["id": id, "url": url], in: nil, in: .page) { _ in }
    }

    // MARK: notifications from the page (Shim.swift)

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        // only the halay page itself may raise notifications
        guard message.frameInfo.isMainFrame, isAppOrigin(message.frameInfo.request.url), let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let id = body["id"] as? String ?? "", tag = body["tag"] as? String ?? ""
        switch type {
        case "notify":
            notifier.post(id: id, title: body["title"] as? String ?? "halay", body: body["body"] as? String ?? "", tag: tag, url: body["url"] as? String ?? "")
        case "close":
            notifier.close(id: id, tag: tag)
        case "drag":   // the page's top strip is the title bar: a mouse down there moves the window
            if let e = NSApp.currentEvent, e.type == .leftMouseDown { window?.performDrag(with: e) }
        case "zoom":
            window?.performZoom(nil)
        case "theme":
            applyTheme(body["color"] as? String ?? "")
        default: break
        }
    }

    /// the page's first rows are as tall as the title bar and start right of the window's buttons: tell it how much (CSS variables)
    func updateInsets() {
        guard let w = window, let wv = webView else { return }
        let full = w.styleMask.contains(.fullScreen)
        // the title bar's height is twice the distance of the buttons' centre from the top (contentLayoutRect also counts the toolbar's own margin)
        let bar = full ? 0 : Double(w.standardWindowButton(.closeButton).map { 2 * (w.frame.height - $0.convert($0.bounds, to: nil).midY) } ?? 52)
        let left = full ? 14 : Double(w.standardWindowButton(.zoomButton).map { $0.convert($0.bounds, to: nil).maxX } ?? 68) + 16
        wv.evaluateJavaScript("document.documentElement.style.setProperty('--halay-bar', '\(Int(bar))px'); document.documentElement.style.setProperty('--halay-inset', '\(Int(left))px')", completionHandler: nil)
    }
    func windowWillClose(_ n: Notification) { AppPolicy.update(closing: n.object as? NSWindow) }
    func windowDidResize(_ n: Notification) { updateInsets() }
    func windowDidEnterFullScreen(_ n: Notification) { updateInsets() }
    func windowDidExitFullScreen(_ n: Notification) { updateInsets() }

    /// the title bar is transparent, so the window's own colour shows through at the edges and its buttons follow the page's light or dark theme
    private func applyTheme(_ hex: String) {
        guard let w = window, hex.hasPrefix("#"), hex.count == 7, let v = UInt32(hex.dropFirst(), radix: 16) else { return }
        let r = CGFloat((v >> 16) & 255) / 255, g = CGFloat((v >> 8) & 255) / 255, b = CGFloat(v & 255) / 255
        w.backgroundColor = NSColor(srgbRed: r, green: g, blue: b, alpha: 1)
        w.appearance = NSAppearance(named: 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? .darkAqua : .aqua)
    }

    // MARK: navigation: the halay origin stays in the window, everything else opens in the default browser

    private func isAppOrigin(_ url: URL?) -> Bool {
        guard let url, let base = client.base ?? loadedBase else { return false }
        return url.scheme == base.scheme && url.host == base.host && url.port == base.port
    }

    private func openExternally(_ url: URL) {
        if let hook = externalOpenOverride { return hook(url) }
        if ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if action.shouldPerformDownload { return decisionHandler(.download) }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "mailto" || scheme == "tel" { openExternally(url); return decisionHandler(.cancel) }
        if (scheme == "http" || scheme == "https") && action.targetFrame?.isMainFrame != false && !isAppOrigin(url) {
            openExternally(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // a file the server sends as an attachment (/raw links) is saved instead of shown
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        decisionHandler(disposition.hasPrefix("attachment") || !response.canShowMIMEType ? .download : .allow)
    }

    /// target=_blank / window.open: never a second web view; the default browser gets it (a /raw link is signed, so it works there)
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openExternally(url) }
        return nil
    }

    // halay's own HTTPS certificate (private CA), for localhost only
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let c = LocalTrust.credential(for: challenge) { completionHandler(.useCredential, c) }
        else { completionHandler(.performDefaultHandling, nil) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled { return }
        showingError = true
        let html = "<body style='font:15px -apple-system;margin:15vh auto;max-width:28em;color:#888'><h2>Can't reach halay</h2><p>\(nsError.localizedDescription)</p><p>Start it with <code>halay</code> or <code>halay service start</code>, then reload (⌘R).</p></body>"
        webView.loadHTMLString(html, baseURL: nil)
    }

    /// A page is on screen (not the "can't reach" note): lets serverBack know whether the window needs the server's page again
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let s = webView.url?.scheme, s == "http" || s == "https" { showingError = false; loadedAt = Date() }
        updateInsets()
    }

    /// The server is reachable again after being away, or it restarted: the open window shows its page again (the old page keeps
    /// the old scripts and styles, and a "can't reach" note never goes away by itself).
    func serverBack(startedAt: Double?) {
        guard let wv = webView else { return }
        if showingError { show(); return }
        guard let startedAt, Date(timeIntervalSince1970: startedAt / 1000) > loadedAt else { return }
        Task { _ = try? await client.ensureSession(); wv.reload() }   // a restart gives the server a new local token: a new session first
    }

    // when the web content process dies the page would stay blank
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // MARK: downloads

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    private var downloaded: [ObjectIdentifier: URL] = [:]

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        let safe = (suggestedFilename as NSString).lastPathComponent
        let base = (safe as NSString).deletingPathExtension, ext = (safe as NSString).pathExtension
        var dest = dir.appendingPathComponent(safe), n = 1
        while FileManager.default.fileExists(atPath: dest.path) { dest = dir.appendingPathComponent("\(base) \(n)" + (ext.isEmpty ? "" : "." + ext)); n += 1 }
        downloaded[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let dest = downloaded.removeValue(forKey: ObjectIdentifier(download)) { NSWorkspace.shared.activateFileViewerSelecting([dest]) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloaded.removeValue(forKey: ObjectIdentifier(download))
        let alert = NSAlert()
        alert.messageText = "Download failed"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    // MARK: <input type="file">, and alert / confirm / prompt (a bare WKWebView answers those with nothing)

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        if let pick = openPanelOverride { return completionHandler(pick()) }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        let done: (NSApplication.ModalResponse) -> Void = { completionHandler($0 == .OK ? panel.urls : nil) }
        if let window { panel.beginSheetModal(for: window, completionHandler: done) } else { done(panel.runModal()) }
    }

    private func alert(_ message: String, buttons: [String], accessory: NSView? = nil, then: @escaping (NSApplication.ModalResponse) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.accessoryView = accessory
        buttons.forEach { a.addButton(withTitle: $0) }
        if let window, window.isVisible { a.beginSheetModal(for: window, completionHandler: then) } else { then(a.runModal()) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        alert(message, buttons: ["OK"]) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        alert(message, buttons: ["OK", "Cancel"]) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert(prompt, buttons: ["OK", "Cancel"], accessory: field) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
}
