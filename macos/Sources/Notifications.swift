import AppKit
import UserNotifications

/// Real macOS notifications for the page's `new Notification(...)` (see Shim.swift).
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    /// a notification was clicked: bring the window up and let the page handle it
    var onClick: ((_ id: String, _ url: String) -> Void)?
    private var asked = false
    /// test hook (SelfTest.swift): sees every notification the page raised, whatever macOS permission says
    var spy: ((String) -> Void)?
    private let center = Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current() // nil when run outside the .app

    override init() {
        super.init()
        center?.delegate = self
    }

    /// what macOS currently allows for this app (nil: not looked up yet, or run outside the .app); shown in the menu
    private(set) var authorization: UNAuthorizationStatus?

    func refreshAuthorization() async {
        guard let center else { return }
        authorization = await center.notificationSettings().authorizationStatus
    }

    /// Asks once (macOS shows its permission prompt the first time). Without permission the page's in-page toasts still work.
    func requestAuthorization() {
        guard let center, !asked else { return }
        asked = true
        center.requestAuthorization(options: [.alert, .sound]) { _, error in
            if let error { NSLog("halay: notification permission: \(error.localizedDescription)") }
        }
    }

    func post(id: String, title: String, body: String, tag: String, url: String) {
        spy?("\(title)|\(body)|\(tag)|\(url)")
        guard let center else { return }
        requestAuthorization()
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["id": id, "url": url]
        // the same tag replaces the earlier notification, as in a browser (agents.js uses the agent id)
        center.add(UNNotificationRequest(identifier: tag.isEmpty ? id : "tag:" + tag, content: content, trigger: nil)) { error in
            if let error { NSLog("halay: can't show notification: \(error.localizedDescription)") }
        }
    }

    func close(id: String, tag: String) {
        let ident = tag.isEmpty ? id : "tag:" + tag
        center?.removeDeliveredNotifications(withIdentifiers: [ident])
        center?.removePendingNotificationRequests(withIdentifiers: [ident])
    }

    // shown even while the app is frontmost: the page already skips the agent you are looking at
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let id = info["id"] as? String ?? "", url = info["url"] as? String ?? ""
        await MainActor.run { onClick?(id, url) }
    }
}
