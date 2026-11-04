import Foundation
import WebKit

/// What the menu shows.
struct ServerSnapshot {
    var base: URL?                       // nil: the server isn't reachable
    var running = 0, blocked = 0, total = 0
    var note: String?                    // why something is missing (not signed in, no token file, ...)
    var startedAt: Double?               // when the server process started (ms), from /api/server: changes when it restarts
    var reachable: Bool { base != nil }
}

/// Accepts a certificate for the local machine only. halay's own HTTPS certificate comes from a private CA that isn't in the
/// keychain, so the system would refuse it; anything that is not localhost / a loopback address gets the normal checks.
enum LocalTrust {
    static let hosts: Set<String> = ["localhost", "127.0.0.1", "::1"]
    static func credential(for challenge: URLAuthenticationChallenge) -> URLCredential? {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, hosts.contains(space.host), let trust = space.serverTrust else { return nil }
        return URLCredential(trust: trust)
    }
}

final class TrustDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let c = LocalTrust.credential(for: challenge) { completionHandler(.useCredential, c) }
        else { completionHandler(.performDefaultHandling, nil) }
    }
}

enum ClientError: Error, CustomStringConvertible {
    case message(String)
    var description: String { if case .message(let m) = self { return m }; return "error" }
}

/// Talks to the halay server over HTTP: finds it (Locator), signs in with the local app token and reads the agents.
///
/// Sign-in: the server writes <data folder>/local-app-token (mode 600). Being able to read it is the proof that this is the
/// same user, so it goes to POST /auth/local in a header, and the answer is a normal halay session cookie. The cookie is
/// kept here (for the status calls) and handed to the web view (WebWindow). When it stops working (a reset, 30 days) the
/// next call signs in again.
@MainActor
final class ServerClient {
    private(set) var base: URL?
    private(set) var cookie: HTTPCookie?
    private let session: URLSession
    /// called when a new session was made, so an open web view can pick it up
    var onNewSession: (() -> Void)?

    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpCookieStorage = nil          // the cookie is ours to send, not shared with anything
        cfg.httpShouldSetCookies = false
        cfg.connectionProxyDictionary = [:]  // a system proxy must never see the token, nor be asked to reach localhost
        cfg.timeoutIntervalForRequest = 3
        session = URLSession(configuration: cfg, delegate: TrustDelegate(), delegateQueue: nil)
    }

    func send(_ base: URL, _ path: String, method: String = "GET", headers: [String: String] = [:], body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: URL(string: path, relativeTo: base)!)
        req.httpMethod = method
        req.httpBody = body
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw ClientError.message("not an HTTP answer") }
        return (data, http)
    }

    private var cookieHeader: [String: String] { cookie.map { ["Cookie": "\($0.name)=\($0.value)"] } ?? [:] }

    /// The first base URL that answers (public /auth/state), or nil.
    private func findBase(_ loc: ServerLocation) async -> URL? {
        guard loc.running || loc.customURL != nil else { return nil }
        for url in loc.candidates {
            if let (_, r) = try? await send(url, "/auth/state"), r.statusCode == 200 { return url }
        }
        return nil
    }

    /// Reads the token file and signs in. Refuses a token file other users could read: then reading it proves nothing.
    /// Local sign-in needs the token file of a server on this Mac: not for another server.
    private func canSignInLocally(_ loc: ServerLocation) -> Bool { loc.customURL.map { LocalTrust.hosts.contains($0.host ?? "") } ?? true }

    private func login(_ loc: ServerLocation, _ base: URL) async throws {
        guard canSignInLocally(loc) else { throw ClientError.message("sign in in the halay window (this server isn't on this Mac)") }
        let attrs = try? FileManager.default.attributesOfItem(atPath: loc.tokenFile.path)
        guard let attrs else { throw ClientError.message("no \(loc.tokenFile.lastPathComponent) in \(loc.dataDir.path) (restart halay: this version of the server may not have it)") }
        let mode = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0
        let owner = (attrs[.ownerAccountID] as? NSNumber)?.uint32Value ?? 0
        guard owner == getuid(), mode & 0o077 == 0 else { throw ClientError.message("\(loc.tokenFile.path) is not private to you (mode \(String(mode, radix: 8))); not using it") }
        guard let token = try? String(contentsOf: loc.tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
            throw ClientError.message("can't read \(loc.tokenFile.path)")
        }
        let (_, r) = try await send(base, "/auth/local", method: "POST", headers: ["x-halay-local-token": token])
        guard r.statusCode == 200 else {
            throw ClientError.message(r.statusCode == 429 ? "too many failed sign-ins; try again later" : r.statusCode == 404 ? "this server has local app sign-in turned off (HALAY_LOCAL_APP=0)" : "the server refused the local token (\(r.statusCode)); it changes at every server start")
        }
        let fields = r.allHeaderFields.reduce(into: [String: String]()) { if let k = $1.key as? String, let v = $1.value as? String { $0[k] = v } }
        guard let c = HTTPCookie.cookies(withResponseHeaderFields: fields, for: base).first(where: { $0.name == "halay_session" }) else {
            throw ClientError.message("the server sent no session cookie")
        }
        cookie = c
        onNewSession?()
    }

    private func loggedIn(_ base: URL) async -> Bool {
        guard cookie != nil, let (data, r) = try? await send(base, "/auth/state", headers: cookieHeader), r.statusCode == 200 else { return false }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["loggedIn"] as? Bool == true
    }

    /// The session the web view already holds (its cookie store survives app restarts), so launching the app again doesn't
    /// make a new session every time.
    private func adoptWebViewCookie(_ base: URL) async {
        let all = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        cookie = all.first { $0.name == "halay_session" && $0.domain == base.host }
    }

    /// Makes sure `cookie` is a session the server accepts: the web view's, else a fresh one from the token file.
    private func validSession(_ loc: ServerLocation, _ base: URL) async throws {
        if cookie == nil { await adoptWebViewCookie(base) }
        if await !loggedIn(base) { try await login(loc, base) }
    }

    /// A signed-in session for the web view: -> the base URL and cookie, or throws why not.
    /// For another server there is no automatic sign-in: the cookie is nil until the user has signed in in the window.
    func ensureSession() async throws -> (URL, HTTPCookie?) {
        let loc = Locator.locate()
        guard let base = await findBase(loc) else {
            throw ClientError.message(loc.customURL.map { "no halay server answers at \($0.absoluteString)" } ?? "the halay server is not running (start it with `halay` or `halay service start`)")
        }
        self.base = base
        do { try await validSession(loc, base) } catch { if canSignInLocally(loc) { throw error }; cookie = nil }
        if cookie == nil && canSignInLocally(loc) { throw ClientError.message("not signed in") }
        return (base, cookie)
    }

    /// Forget the server and the session (Settings changed them).
    func reset() { base = nil; cookie = nil }

    /// What Settings → Test Connection tells: one line about this location, without touching the session.
    func describe(_ loc: ServerLocation) async -> String {
        guard let base = await findBase(loc) else {
            if let u = loc.customURL { return "No halay server answers at \(u.absoluteString)." }
            return loc.running ? "The server in \(loc.dataDir.path) isn't answering on \(loc.candidates[0].absoluteString)." : "No running halay server found in \(loc.dataDir.path)."
        }
        if !canSignInLocally(loc) { return "Reachable at \(base.absoluteString). Sign in in the halay window." }
        let token = FileManager.default.isReadableFile(atPath: loc.tokenFile.path)
        return "Reachable at \(base.absoluteString)." + (token ? " It signs in automatically." : " No \(loc.tokenFile.lastPathComponent) in \(loc.dataDir.path): restart the server, or sign in in the window.")
    }

    /// One look at the server for the menu: reachable? how many agents are running / blocked?
    func snapshot() async -> ServerSnapshot {
        let loc = Locator.locate()
        guard let base = await findBase(loc) else { self.base = nil; return ServerSnapshot(note: loc.running ? "not answering on \(loc.candidates[0].absoluteString)" : "not running") }
        self.base = base
        var snap = ServerSnapshot(base: base)
        for attempt in 0..<2 {
            do {
                if cookie == nil || attempt == 1 { try await validSession(loc, base) }
                let (data, r) = try await send(base, "/api/agents", headers: cookieHeader)
                if r.statusCode == 401 { cookie = nil; continue }
                guard r.statusCode == 200, let agents = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { snap.note = "unexpected answer (\(r.statusCode))"; return snap }
                // the same words the web UI uses (public/js/agents.js): status running; attention.kind blocked = waits for an approval or answer
                snap.total = agents.count
                snap.running = agents.filter { $0["status"] as? String == "running" }.count
                snap.blocked = agents.filter { ($0["attention"] as? [String: Any])?["kind"] as? String == "blocked" }.count
                snap.note = nil
                if let (d, r) = try? await send(base, "/api/server", headers: cookieHeader), r.statusCode == 200 {
                    snap.startedAt = ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any])?["startedAt"] as? Double
                }
                return snap
            } catch {
                snap.note = "\(error)"
                return snap
            }
        }
        snap.note = "could not sign in"
        return snap
    }
}
