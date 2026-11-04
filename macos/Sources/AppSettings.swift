import Foundation

/// What the user chose in the app's Settings window (SettingsWindow.swift). Both are optional: nothing set = automatic, the way
/// the app found the server before there were settings. A value set here wins over --data-dir, HALAY_HOME and what the last
/// `halay app` passed, because it is the user's explicit choice (`halay app` passes --data-dir every time).
enum AppSettings {
    static let dataDirKey = "settings.dataDir"
    static let serverURLKey = "settings.serverURL"

    static func dataDir(_ d: UserDefaults? = .standard) -> String? {
        guard let v = d?.string(forKey: dataDirKey)?.trimmingCharacters(in: .whitespaces), !v.isEmpty else { return nil }
        return v
    }

    static func serverURL(_ d: UserDefaults? = .standard) -> URL? {
        guard let v = d?.string(forKey: serverURLKey), case .success(let url?) = parseServerURL(v) else { return nil }
        return url
    }

    /// "mac-mini:4777", "https://halay.example.com/" -> scheme://host[:port]; empty -> nil (automatic); anything else is an error text.
    static func parseServerURL(_ text: String) -> Result<URL?, SettingsError> {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return .success(nil) }
        if !t.contains("://") { t = "http://" + t }
        guard let c = URLComponents(string: t), let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = c.host, !host.isEmpty else {
            return .failure(SettingsError("Enter the server as http://host:port or https://host (for example http://mac-mini.local:4777)."))
        }
        if c.user != nil || c.password != nil { return .failure(SettingsError("Leave the user name and password out of the address; sign in in the window.")) }
        var out = URLComponents()
        out.scheme = scheme; out.host = host; out.port = c.port
        return out.url.map { .success($0) } ?? .failure(SettingsError("That address can't be used."))
    }

    /// "~/x" -> an absolute path; relative paths are refused (an app has no meaningful working directory).
    static func parseDataDir(_ text: String) -> Result<String?, SettingsError> {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return .success(nil) }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let full = t == "~" ? home : t.hasPrefix("~/") ? home + t.dropFirst() : t
        guard full.hasPrefix("/") else { return .failure(SettingsError("Enter the data folder as a full path, such as ~/.halay.")) }
        return .success(URL(fileURLWithPath: full).standardized.path)
    }
}

struct SettingsError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}
