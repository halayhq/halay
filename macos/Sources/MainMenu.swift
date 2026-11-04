import AppKit

/// An accessory app has no menu bar of its own, but its window still routes key equivalents through NSApp.mainMenu:
/// without an Edit menu Cmd+C/V/X/A/Z do nothing in a web view, and without these Cmd+W / Cmd+R don't work either.
/// The menu bar shows while the window is open (WebWindow.reveal makes the app a regular one); with only the menu-bar icon
/// there is none.
@MainActor
enum MainMenu {
    static func build(target: AnyObject, reload: Selector, zoom: Selector, settings: (AnyObject, Selector)) -> NSMenu {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem(); main.addItem(holder)
            let menu = NSMenu(title: title); holder.submenu = menu
            items.forEach(menu.addItem)
        }
        func item(_ title: String, _ action: Selector?, _ key: String, _ mods: NSEvent.ModifierFlags = .command, target t: AnyObject? = nil, tag: Int = 0) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = t   // nil: the responder chain (the web view for the editing commands, the window for Close)
            i.tag = tag
            return i
        }
        add("halay", [
            item("About halay", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            .separator(),
            item("Settings…", settings.1, ",", target: settings.0),
            .separator(),
            item("Hide halay", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            .separator(),
            item("Quit halay", #selector(NSApplication.terminate(_:)), "q"),
        ])
        add("File", [
            item("Reload", reload, "r", target: target),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        add("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        add("View", [
            item("Actual Size", zoom, "0", target: target, tag: 0),
            item("Zoom In", zoom, "+", target: target, tag: 1),
            item("Zoom In", zoom, "=", target: target, tag: 1),   // Cmd+= is the unshifted key
            item("Zoom Out", zoom, "-", target: target, tag: -1),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        add("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
        ])
        NSApp.windowsMenu = main.items.last?.submenu
        return main
    }
}
