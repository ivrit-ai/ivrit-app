import UIKit
import UserNotifications

/// This install's place in Apple's push service, and the taps on its
/// notifications. The app delegate hands over what iOS tells it; the plugin
/// asks for the token and takes the tapped message's id.
final class Push {
    static let shared = Push()

    private var waiting: [(Result<String, Error>) -> Void] = []
    private var pendingOpen: String?

    struct NoToken: Error {}

    /// Which of Apple's services the token belongs to: "sandbox" for builds signed
    /// for development (their provisioning profile says so), "production" for
    /// TestFlight and the App Store, which carry no profile in the app.
    static let environment: String = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let raw = try? Data(contentsOf: url),
              let text = String(data: raw, encoding: .isoLatin1),
              let start = text.range(of: "<plist"),
              let end = text.range(of: "</plist>"),
              let plist = try? PropertyListSerialization.propertyList(
                  from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let aps = entitlements["aps-environment"] as? String else { return "production" }
        return aps == "development" ? "sandbox" : "production"
    }()

    /// The device token, as lowercase hex. iOS answers through the app delegate.
    func register(_ done: @escaping (Result<String, Error>) -> Void) {
        DispatchQueue.main.async {
            self.waiting.append(done)
            UIApplication.shared.registerForRemoteNotifications()
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.settle(.failure(NoToken())) }
        }
    }

    func registered(_ token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        // Apple replaced the token (a restore, a new phone): the page registers again.
        if let known = Store.defaults.string(forKey: "push_token"), known != hex {
            IvritNativePlugin.emit("pushToken", [:])
        }
        settle(.success(hex))
    }

    /// At launch: iOS tells the token only when asked, so a changed one is noticed here.
    func refresh() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func failed(_ error: Error) {
        settle(.failure(error))
    }

    private func settle(_ result: Result<String, Error>) {
        DispatchQueue.main.async {
            let callbacks = self.waiting
            self.waiting = []
            callbacks.forEach { $0(result) }
        }
    }

    // MARK: taps

    /// A notification was tapped: its message, for the page (now, and through takeOpened).
    func opened(_ id: String?) {
        DispatchQueue.main.async {
            guard let id, !id.isEmpty else { return }
            self.pendingOpen = id
            IvritNativePlugin.emit("opened", ["id": id])
        }
    }

    /// A tap from before the page was there to hear it (it launched the app).
    func peekOpened() -> String? {
        pendingOpen
    }

    func takeOpened() -> String? {
        defer { pendingOpen = nil }
        return pendingOpen
    }
}
