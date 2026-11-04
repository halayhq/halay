import AppKit

// A menu-bar (accessory) app: no Dock icon, no menu bar of its own (Info.plist LSUIElement does the same for a Finder launch).
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    app.delegate = delegate   // NSApplication keeps only a weak reference
    withExtendedLifetime(delegate) { app.run() }
}
