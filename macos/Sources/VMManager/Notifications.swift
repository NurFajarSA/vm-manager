import AppKit
import Foundation
import UserNotifications

enum ApprovalAction {
    static let category = "approval"
    static let approve = "approve"
    static let deny = "deny"
}

extension Notification.Name {
    static let showApprovals = Notification.Name("app.vm-manager.showApprovals")
}

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    static let enabledKey = "notificationsEnabled"

    static var enabled: Bool {
        UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
    }

    weak var store: Store?
    private var attached = false

    private var center: UNUserNotificationCenter? {
        Bundle.main.bundleURL.pathExtension == "app" ? UNUserNotificationCenter.current() : nil
    }

    func attach() {
        guard !attached, let center else { return }
        attached = true
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: ApprovalAction.category,
                actions: [
                    // Approving from a banner still needs an unlocked Mac.
                    UNNotificationAction(identifier: ApprovalAction.approve, title: "Approve", options: [.authenticationRequired]),
                    UNNotificationAction(identifier: ApprovalAction.deny, title: "Deny", options: [.destructive]),
                ],
                intentIdentifiers: [],
                options: [.customDismissAction]
            )
        ])
    }

    func postApproval(_ approval: Approval) async {
        guard Self.enabled, let center else { return }
        attach()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            status = await center.notificationSettings().authorizationStatus
        }
        guard status == .authorized || status == .provisional else { return }
        let content = UNMutableNotificationContent()
        content.title = "Approve on \(approval.vm)\(approval.env == "prod" ? " (prod)" : "")?"
        content.subtitle = approval.requester
        content.body = approval.command + (approval.why.map { "\n\($0)" } ?? "")
        content.sound = .default
        content.categoryIdentifier = ApprovalAction.category
        content.userInfo = ["approval": approval.id]
        try? await center.add(UNNotificationRequest(identifier: "approval:\(approval.id)", content: content, trigger: nil))
    }

    /// Takes down notifications for requests that were decided or expired elsewhere.
    func withdraw(_ ids: Set<String>) {
        guard !ids.isEmpty, let center else { return }
        let identifiers = ids.map { "approval:\($0)" }
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let action = response.actionIdentifier
        let id = response.notification.request.content.userInfo["approval"] as? String
        Task { @MainActor in
            switch action {
            case ApprovalAction.approve:
                if let id { await Notifier.shared.store?.approve(id: id) }
            case ApprovalAction.deny:
                if let id { await Notifier.shared.store?.deny(id: id) }
            case UNNotificationDefaultActionIdentifier:
                NotificationCenter.default.post(name: .showApprovals, object: nil)
            default:
                break
            }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }
}
