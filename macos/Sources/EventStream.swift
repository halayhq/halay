import Foundation

/// Agents' notifications while no web page is loaded.
///
/// The page raises them itself (`new Notification`, Shim.swift), but only once the window has been opened. Until then this
/// listens to the same server feed the page uses (the /ws WebSocket, `notify` messages) and posts the same macOS
/// notifications, with the same title, text, tag and click target as public/js/agents.js onNotify. Once the web view exists the
/// page takes over and this stops, so nothing is shown twice (closing the window only hides it; the page keeps running).
/// Like the page, it shows every `notify` message; the per-event choices in Settings only filter Web Push and plugins.
@MainActor
final class EventStream {
    private let client: ServerClient
    private let notifier: Notifier
    private var task: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private let session: URLSession

    private static let kindText = ["done": "done", "error": "error", "blocked": "needs approval", "usage": "usage", "stuck": "stuck", "context": "big context", "room": "room"]  // public/js/agents.js KIND_TXT

    init(client: ServerClient, notifier: Notifier) {
        self.client = client
        self.notifier = notifier
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        cfg.connectionProxyDictionary = [:]
        session = URLSession(configuration: cfg, delegate: TrustDelegate(), delegateQueue: nil)
    }

    var isRunning: Bool { task != nil }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            var wait = 2.0
            while !Task.isCancelled {
                guard let self else { return }
                if await self.listen() { wait = 2 } else { wait = min(wait * 2, 30) }
                try? await Task.sleep(nanoseconds: UInt64(wait * 1e9))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    /// One connection, until it drops. -> whether it was ever connected (resets the retry delay)
    private func listen() async -> Bool {
        guard case let (base, cookie?)? = try? await client.ensureSession(), var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return false }
        parts.scheme = base.scheme == "https" ? "wss" : "ws"
        parts.path = "/ws"
        guard let url = parts.url else { return false }
        var req = URLRequest(url: url)
        req.setValue("\(cookie.name)=\(cookie.value)", forHTTPHeaderField: "Cookie")
        let ws = session.webSocketTask(with: req)
        socket = ws
        ws.resume()
        var connected = false
        while !Task.isCancelled {
            guard let message = try? await ws.receive() else { break }   // the server went away, or the session ended
            connected = true
            if case .string(let text) = message { handle(text) }
        }
        ws.cancel(with: .goingAway, reason: nil)
        return connected
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], m["type"] as? String == "notify" else { return }
        let name = m["name"] as? String ?? "halay", kind = m["kind"] as? String ?? ""
        let label = (m["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? Self.kindText[kind] ?? ""
        let agentId = m["agentId"] as? String
        let to = agentId.map { "/a/" + $0 } ?? "/tasks"   // no agent: a schedule's skipped run
        notifier.post(id: UUID().uuidString, title: label.isEmpty ? name : "\(name) · \(label)", body: m["text"] as? String ?? "", tag: agentId ?? name, url: "/#" + to)
    }
}
