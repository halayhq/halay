import AppKit
import ServiceManagement

/// Start at login: the app registers itself as a login item (SMAppService.mainApp), so it shows up, and can be switched off, in
/// System Settings → General → Login Items. It registers the bundle where it sits now, so install it first (`halay app install`
/// copies it to ~/Applications); an app moved afterwards has to be switched off and on again.
@MainActor
enum LaunchAtLogin {
    static var status: SMAppService.Status { SMAppService.mainApp.status }

    static var state: NSControl.StateValue {
        switch status {
        case .enabled: return .on
        case .requiresApproval: return .mixed
        default: return .off
        }
    }

    static var title: String { status == .requiresApproval ? "Launch at Login (allow in System Settings…)" : "Launch at Login" }

    /// Settings' checkbox: -> nil, or what went wrong
    static func set(_ on: Bool) -> String? {
        if on == (status == .enabled) { return nil }
        if on, status == .requiresApproval { SMAppService.openSystemSettingsLoginItems(); return nil }
        return toggle()
    }

    /// -> nil, or what went wrong
    static func toggle() -> String? {
        switch status {
        case .requiresApproval:
            SMAppService.openSystemSettingsLoginItems()   // macOS wants the user's own switch for an app it hasn't seen
            return nil
        case .enabled:
            do { try SMAppService.mainApp.unregister(); return nil } catch { return error.localizedDescription }
        default:
            do { try SMAppService.mainApp.register() } catch { return error.localizedDescription }
            if status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            return nil
        }
    }
}
