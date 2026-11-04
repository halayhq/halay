import AppKit
import ServiceManagement

/// The menu-bar item: server status, Open halay, Launch at Login, Quit.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let client = ServerClient()
    let notifier = Notifier()
    lazy var web = WebWindow(client: client, notifier: notifier)
    lazy var events = EventStream(client: client, notifier: notifier)
    lazy var settings = SettingsWindow(client: client)
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var snapshot = ServerSnapshot()
    private var timer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.mainMenu = MainMenu.build(target: web, reload: #selector(WebWindow.reload(_:)), zoom: #selector(WebWindow.zoom(_:)), settings: (self, #selector(openSettings)))
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        menu.delegate = self
        settings.onSave = { [weak self] in self?.settingsSaved() }
        statusItem.menu = menu
        render()
        refresh()
        web.onWebViewCreated = { [weak self] in self?.events.stop() }   // the page takes over the notifications
        events.start()
        notifier.requestAuthorization()   // macOS asks the first time; asking now, not at the first alert, so the prompt isn't a surprise
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
        #if SELFTEST
        Task { await SelfTest.run(self) }
        #else
        // Spotlight, Finder and `halay app` open the UI; a start at login only puts the icon in the menu bar
        if !launchedAtLogin { web.show() }
        #endif
    }

    /// macOS sends the open event of a login item with the property "launched as login item" (keyAELaunchedAsLogInItem, 'lgit')
    private var launchedAtLogin = false
    func applicationWillFinishLaunching(_ note: Notification) {   // the open event is still the current one here
        if let ev = NSAppleEventManager.shared().currentAppleEvent, ev.eventID == AEEventID(kAEOpenApplication) {
            launchedAtLogin = ev.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
        }
    }

    // clicking the app's icon again (Finder, `open`) shows the window: there is no Dock icon to click
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { web.show(); return false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func refresh() {
        Task {
            let before = snapshot
            snapshot = await client.snapshot()
            await notifier.refreshAuthorization()
            // the server went away and came back, or restarted between two looks: bring the open window along
            if snapshot.reachable, !before.reachable || (before.startedAt != nil && snapshot.startedAt != before.startedAt) { web.serverBack(startedAt: snapshot.startedAt) }
            if menuOpen { menuDirty = true } else { render() }
        }
    }

    // The menu is rebuilt just before it opens, from the last look (the timer keeps that one at most 5 seconds old), and not while
    // it is open: rebuilding an open menu with fewer items than it opened with leaves it at its old height, an empty strip under Quit.
    private var menuOpen = false, menuDirty = false
    func menuNeedsUpdate(_ menu: NSMenu) { render() }
    func menuWillOpen(_ menu: NSMenu) { menuOpen = true; refresh() }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false; if menuDirty { menuDirty = false; render() } }

    private func render() {
        let s = snapshot
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: s.reachable ? "terminal.fill" : "terminal", accessibilityDescription: "halay")
            image?.isTemplate = true
            button.image = image
            button.imagePosition = .imageLeading
            button.title = s.blocked > 0 ? " \(s.blocked)" : ""   // agents waiting for you
            button.toolTip = s.reachable ? "halay" : "halay: server not reachable"
        }
        menu.removeAllItems()
        func label(_ text: String) { let i = NSMenuItem(title: text, action: nil, keyEquivalent: ""); i.isEnabled = false; menu.addItem(i) }
        if let base = s.base {
            label("Server: running on \(base.host ?? "localhost"):\(base.port ?? 80)")
            if let note = s.note { label(note) }
            else { label("Agents: \(s.running) running, \(s.blocked) blocked" + (s.total > 0 ? " (of \(s.total))" : "")) }
        } else {
            label("Server: not reachable" + (s.note.map { " (\($0))" } ?? ""))
            label("Start it with `halay` or `halay service start`")
        }
        if notifier.authorization == .denied {
            menu.addItem(.separator())
            label("Notifications are off for halay in macOS")
            menu.addItem(item("Open Notification Settings…", #selector(openNotificationSettings), ""))
        }
        menu.addItem(.separator())
        menu.addItem(item("Open halay", #selector(openWindow), "o", enabled: s.reachable))
        menu.addItem(item("Settings…", #selector(openSettings), ","))
        let login = item(LaunchAtLogin.title, #selector(toggleLaunchAtLogin), "")
        login.state = LaunchAtLogin.state
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(item("Quit halay", #selector(NSApplication.terminate(_:)), "q", target: NSApp))
    }

    private func item(_ title: String, _ action: Selector, _ key: String, enabled: Bool = true, target: AnyObject? = nil) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = target ?? self
        i.isEnabled = enabled
        return i
    }

    @objc func openNotificationSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
    }

    @objc func toggleLaunchAtLogin() {
        if let problem = LaunchAtLogin.toggle() {
            let a = NSAlert()
            a.messageText = "Can't change Launch at Login"
            a.informativeText = problem
            NSApp.activate(ignoringOtherApps: true)
            a.runModal()
        }
    }

    @objc func openWindow() { web.show() }

    @objc func openSettings() { settings.show() }

    /// Settings were saved: forget the old server and session, look again, and move the open window to the new server
    func settingsSaved() {
        client.reset()
        snapshot = ServerSnapshot()
        render()
        if web.web != nil { web.show() } else { events.stop(); events.start() }
        refresh()
    }
}
