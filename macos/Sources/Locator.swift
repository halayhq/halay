import Foundation

/// Where the halay server is, found the way the CLI does (cli.js context() and withRunning()): the data folder first, then
/// what the running server wrote to <data folder>/runs/server.json (its real port, bind host and HTTPS port, which a
/// `--port` flag or a service's PORT would otherwise hide), then the settings (PORT in the environment or in .env), then 4777.
struct ServerLocation {
    var dataDir: URL
    var port: Int
    var host: String        // what the HTTP listener is bound to
    var httpsPort: Int?
    var running: Bool       // server.json names a process that is alive
    var customURL: URL? = nil   // Settings → Another server: used as it is, nothing is looked up in the data folder

    var tokenFile: URL { dataDir.appendingPathComponent("local-app-token") }

    /// Base URLs to try, in order. Plain http on localhost first (a passkey needs a name, and no certificate is involved);
    /// HTTPS only when the http listener isn't reachable from here.
    var candidates: [URL] {
        if let customURL { return [customURL] }
        let wildcard: Set<String> = ["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"]
        let h = wildcard.contains(host) ? "localhost" : host.contains(":") ? "[\(host)]" : host
        var out = [URL(string: "http://\(h):\(port)")!]
        if let p = httpsPort { out.append(URL(string: "https://localhost:\(p)")!) }
        return out
    }
}

enum Locator {
    /// Settings (AppSettings) first, then `--data-dir` / `--port` (what `halay app` passes, resolved by the CLI), else HALAY_HOME / PORT, else the ones the last
    /// `halay app` passed (remembered below), else ~/.halay.
    /// A Finder, Spotlight or login launch has no shell environment and no flags: without the remembered folder an app started
    /// at login would look in ~/.halay while the server's data is somewhere else.
    static func locate(args: [String] = CommandLine.arguments, env: [String: String] = ProcessInfo.processInfo.environment, defaults: UserDefaults? = .standard, ignoreSettings: Bool = false) -> ServerLocation {
        func arg(_ name: String) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        func expand(_ p: String) -> URL { URL(fileURLWithPath: p.hasPrefix("~") ? home.path + p.dropFirst() : p) }
        if let d = arg("--data-dir") { defaults?.set(d, forKey: "lastDataDir") }
        if let p = arg("--port") { defaults?.set(p, forKey: "lastPort") }
        let explicit = arg("--data-dir") ?? env["HALAY_HOME"]
        let chosen = ignoreSettings ? nil : AppSettings.dataDir(defaults)   // Settings → Data folder wins over everything
        let dir = (chosen ?? explicit ?? defaults?.string(forKey: "lastDataDir")).map(expand) ?? home.appendingPathComponent(".halay")
        // the remembered port goes with the remembered folder only
        let savedPort = chosen == nil && explicit == nil ? defaults?.string(forKey: "lastPort") : nil

        let dotenv = parseEnvFile(dir.appendingPathComponent(".env"))
        var loc = ServerLocation(
            dataDir: dir,
            port: Int((chosen == nil ? arg("--port") : nil) ?? "") ?? Int(env["PORT"] ?? dotenv["PORT"] ?? savedPort ?? "") ?? 4777,
            host: env["HOST"] ?? dotenv["HOST"] ?? "127.0.0.1",
            httpsPort: nil, running: false, customURL: ignoreSettings ? nil : AppSettings.serverURL(defaults))

        if loc.customURL != nil { return loc }   // another server: the data folder only holds the token, for a server on this Mac
        let json = (try? Data(contentsOf: dir.appendingPathComponent("runs/server.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        if let pid = json?["pid"] as? Int, let port = json?["port"] as? Int, alive(pid) {
            loc.port = port
            loc.host = (json?["host"] as? String) ?? loc.host
            loc.httpsPort = json?["httpsPort"] as? Int
            loc.running = true
        }
        return loc
    }

    static func alive(_ pid: Int) -> Bool {
        pid > 1 && (kill(pid_t(pid), 0) == 0 || errno == EPERM)
    }

    /// KEY=VALUE lines of a .env file (comments, `export`, and quotes handled; enough for PORT and HOST).
    static func parseEnvFile(_ url: URL) -> [String: String] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [:] }
        var out: [String: String] = [:]
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#") || line.isEmpty { continue }
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = line[..<eq].trimmingCharacters(in: .whitespaces)
            var value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if let q = value.first, q == "\"" || q == "'", let end = value.dropFirst().firstIndex(of: q) { value = String(value[value.index(after: value.startIndex)..<end]) }
            else if let hash = value.range(of: " #") { value = String(value[..<hash.lowerBound]) }
            out[key] = value
        }
        return out
    }
}
