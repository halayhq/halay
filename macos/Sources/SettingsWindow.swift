import AppKit

/// Dock icon and menu bar only while a window (the UI or Settings) is open; otherwise the app is just its menu-bar icon.
@MainActor
enum AppPolicy {
    static func update(closing: NSWindow? = nil) {
        let open = NSApp.windows.contains { $0 !== closing && $0.isVisible && $0.styleMask.contains(.titled) }
        NSApp.setActivationPolicy(open ? .regular : .accessory)
    }
}

/// Settings…: which server the app talks to and where its data folder is. Both default to automatic (what the app did before
/// there were settings); a value set here wins over the flags `halay app` passes (AppSettings.swift).
@MainActor
final class SettingsWindow: NSObject, NSWindowDelegate {
    private(set) var window: NSWindow?
    private let client: ServerClient
    private let defaults: UserDefaults
    /// called after Save, so the app can drop its session and look for the server again
    var onSave: (() -> Void)?

    let automatic = NSButton(radioButtonWithTitle: "This Mac (found automatically)", target: nil, action: nil)
    let another = NSButton(radioButtonWithTitle: "Another server:", target: nil, action: nil)
    let urlField = NSTextField()
    let dirField = NSTextField()
    private let choose = NSButton(title: "Choose…", target: nil, action: nil)
    let loginBox = NSButton(checkboxWithTitle: "Start halay when I log in (menu-bar icon only)", target: nil, action: nil)
    let status = NSTextField(wrappingLabelWithString: "")
    private var loginAtOpen = false

    init(client: ServerClient, defaults: UserDefaults = .standard) {
        self.client = client
        self.defaults = defaults
        super.init()
    }

    // MARK: window

    func show() {
        let w = window ?? build()
        load()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }

    private func build() -> NSWindow {
        automatic.target = self; automatic.action = #selector(modeChanged)
        another.target = self; another.action = #selector(modeChanged)
        urlField.placeholderString = "http://mac-mini.local:4777  or  https://halay.example.com"
        dirField.placeholderString = Locator.locate(defaults: defaults, ignoreSettings: true).dataDir.path
        choose.target = self; choose.action = #selector(chooseFolder)
        status.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: 11)
        status.preferredMaxLayoutWidth = 440

        func caption(_ t: String) -> NSTextField { let l = NSTextField(wrappingLabelWithString: t); l.font = .systemFont(ofSize: 11); l.textColor = .secondaryLabelColor; l.preferredMaxLayoutWidth = 440; return l }
        func heading(_ t: String) -> NSTextField { let l = NSTextField(labelWithString: t); l.font = .boldSystemFont(ofSize: 13); return l }

        let urlRow = NSStackView(views: [NSView(frame: NSRect(x: 0, y: 0, width: 18, height: 1)), urlField]); urlRow.spacing = 0
        let dirRow = NSStackView(views: [dirField, choose]); dirRow.spacing = 8
        let test = NSButton(title: "Test Connection", target: self, action: #selector(testConnection))
        let reset = NSButton(title: "Use Automatic Settings", target: self, action: #selector(resetToAutomatic))
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancel.keyEquivalent = "\u{1b}"
        let save = NSButton(title: "Save", target: self, action: #selector(save))
        save.keyEquivalent = "\r"
        let leftButtons = NSStackView(views: [test, reset]); leftButtons.spacing = 8
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttons = NSStackView(views: [leftButtons, spacer, cancel, save]); buttons.spacing = 8

        let stack = NSStackView(views: [
            heading("Server"), automatic, another, urlRow,
            caption("Another server is a halay on another machine (or a different port here). It has no automatic sign-in: sign in once in the halay window. Use https for anything off this network."),
            heading("Data folder"), dirRow,
            caption("Where halay keeps its data on this Mac. The app finds the local server there and signs in with the token it holds. Empty = automatic."),
            heading("Startup"), loginBox,
            status, buttons,
        ])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
        for v in [urlRow, dirRow, buttons] { v.translatesAutoresizingMaskIntoConstraints = false; v.widthAnchor.constraint(equalToConstant: 452).isActive = true }
        for i in [4, 7] { stack.setCustomSpacing(18, after: stack.arrangedSubviews[i]) }

        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 420), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "halay Settings"
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.contentView = stack
        w.setContentSize(NSSize(width: 500, height: stack.fittingSize.height))
        w.center()
        window = w
        return w
    }

    /// the fields from what is stored
    func load() {
        let url = defaults.string(forKey: AppSettings.serverURLKey) ?? ""
        let useAnother = AppSettings.serverURL(defaults) != nil
        automatic.state = useAnother ? .off : .on
        another.state = useAnother ? .on : .off
        urlField.stringValue = useAnother ? url : ""
        dirField.stringValue = AppSettings.dataDir(defaults) ?? ""
        loginAtOpen = LaunchAtLogin.status == .enabled
        loginBox.state = loginAtOpen ? .on : .off
        status.stringValue = ""
        status.textColor = .secondaryLabelColor
        modeChanged()
    }

    // MARK: actions

    @objc private func modeChanged() {
        urlField.isEnabled = another.state == .on
        if another.state == .on { window?.makeFirstResponder(urlField) }
    }

    @objc private func chooseFolder() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true
        p.prompt = "Choose"
        p.message = "Choose halay's data folder (the one with halay.db and runs/)"
        if !dirField.stringValue.isEmpty { p.directoryURL = URL(fileURLWithPath: (dirField.stringValue as NSString).expandingTildeInPath) }
        guard let w = window else { return }
        p.beginSheetModal(for: w) { [weak self] r in if r == .OK, let u = p.url { self?.dirField.stringValue = u.path } }
    }

    @objc private func resetToAutomatic() {
        automatic.state = .on; another.state = .off
        urlField.stringValue = ""; dirField.stringValue = ""
        modeChanged()
        say("Automatic again. Save to use it.", error: false)
    }

    /// the fields, checked: -> (server url or nil, data folder or nil), or what is wrong
    func parsed() -> Result<(URL?, String?), SettingsError> {
        let server: URL?
        if another.state == .on {
            switch AppSettings.parseServerURL(urlField.stringValue) {
            case .failure(let e): return .failure(e)
            case .success(nil): return .failure(SettingsError("Enter the other server's address, or choose This Mac."))
            case .success(let u): server = u
            }
        } else { server = nil }
        switch AppSettings.parseDataDir(dirField.stringValue) {
        case .failure(let e): return .failure(e)
        case .success(let d): return .success((server, d))
        }
    }

    @objc private func testConnection() {
        guard case .success(let (server, dir)) = parsed() else { if case .failure(let e) = parsed() { say("\(e)", error: true) }; return }
        say("Checking…", error: false)
        // the same lookup the app does, on a scratch copy of the choices (nothing is saved by a test)
        let scratch = UserDefaults(suiteName: "app.halay.mac.settings-test")!
        scratch.removePersistentDomain(forName: "app.halay.mac.settings-test")
        if let server { scratch.set(server.absoluteString, forKey: AppSettings.serverURLKey) }
        if let dir { scratch.set(dir, forKey: AppSettings.dataDirKey) }
        if let last = defaults.string(forKey: "lastDataDir") { scratch.set(last, forKey: "lastDataDir") }
        if let last = defaults.string(forKey: "lastPort") { scratch.set(last, forKey: "lastPort") }
        let loc = Locator.locate(defaults: scratch)
        scratch.removePersistentDomain(forName: "app.halay.mac.settings-test")
        Task { let t = await client.describe(loc); say(t, error: t.hasPrefix("No ") || t.contains("isn't answering")) }
    }

    @objc func save() {
        let (server, dir): (URL?, String?)
        switch parsed() {
        case .failure(let e): return say("\(e)", error: true)
        case .success(let v): (server, dir) = v
        }
        if let server { defaults.set(server.absoluteString, forKey: AppSettings.serverURLKey) } else { defaults.removeObject(forKey: AppSettings.serverURLKey) }
        if let dir { defaults.set(dir, forKey: AppSettings.dataDirKey) } else { defaults.removeObject(forKey: AppSettings.dataDirKey) }
        if (loginBox.state == .on) != loginAtOpen, let problem = LaunchAtLogin.set(loginBox.state == .on) { return say(problem, error: true) }
        onSave?()
        window?.close()
    }

    @objc private func cancel() { window?.close() }

    func windowWillClose(_ n: Notification) { AppPolicy.update(closing: window) }

    private func say(_ text: String, error: Bool) {
        status.stringValue = text
        status.textColor = error ? .systemRed : .secondaryLabelColor
    }
}
