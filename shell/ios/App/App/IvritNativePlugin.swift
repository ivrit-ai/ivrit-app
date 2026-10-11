import Capacitor
import UIKit
import UserNotifications
import WebKit

/// What the web app asks of the native shell (shell/native-api.json): push
/// through Apple, the state of this app's notification settings, Google sign-in
/// and Drive, and files shared into the app. The iPhone side of Android's
/// IvritNativePlugin: the same methods, answers and events.
@objc(IvritNativePlugin)
public class IvritNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IvritNativePlugin"
    public let jsName = "IvritNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "notificationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openNotificationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushRegistration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeOpened", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "googleIdToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authorizeDrive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetGoogle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enqueueTranscription", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "uploadToTranscribe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sharedFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardShared", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareOn", returnType: CAPPluginReturnPromise),
    ]

    private static weak var current: IvritNativePlugin?

    override public func load() {
        Self.current = self
        // Files shared while the app runs (the share extension's Darwin
        // notification), and those shared while it was closed (on becoming active).
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { _, observer, _, _, _ in
                guard let observer else { return }
                let plugin = Unmanaged<IvritNativePlugin>.fromOpaque(observer).takeUnretainedValue()
                DispatchQueue.main.async { plugin.takeShared() }
            },
            Shares.darwinName as CFString, nil, .deliverImmediately)
        NotificationCenter.default.addObserver(
            self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        if let id = Push.shared.peekOpened() {
            notifyListeners("opened", data: ["id": id], retainUntilConsumed: true)
        }
        takeShared()
    }

    deinit {
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    }

    @objc private func becameActive() {
        takeShared()
    }

    private func takeShared() {
        guard Store.defaults.bool(forKey: Shares.pendingKey) else { return }
        Store.defaults.set(false, forKey: Shares.pendingKey)
        notifyListeners("shared", data: [:], retainUntilConsumed: true)
    }

    /// An event for the page, from anywhere in the app. Kept until the page
    /// listens, as on Android, except "push", which matters only while it is open.
    static func emit(_ event: String, _ data: [String: Any]) {
        DispatchQueue.main.async {
            current?.notifyListeners(event, data: data, retainUntilConsumed: event != "push")
        }
    }

    // MARK: notifications

    private static func status() async -> [String: Any] {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let permission: String
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: permission = "granted"
        case .denied: permission = "denied"
        default: permission = "default"
        }
        // Allowed, yet set to show only in Notification Centre: no banner pops up.
        let popup = settings.alertSetting == .enabled && settings.alertStyle != .none
        return ["available": true, "permission": permission, "popup": popup, "platform": "ios"]
    }

    @objc func notificationStatus(_ call: CAPPluginCall) {
        Task { call.resolve(await Self.status()) }
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            call.resolve(await Self.status())
        }
    }

    /// This app's notification settings (iOS 16+), or its settings page.
    @objc func openNotificationSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let target: String
            if #available(iOS 16.0, *) {
                target = UIApplication.openNotificationSettingsURLString
            } else {
                target = UIApplication.openSettingsURLString
            }
            if let url = URL(string: target) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    /// This device's APNs token and message key, for registering with Communicator.
    @objc func pushRegistration(_ call: CAPPluginCall) {
        Push.shared.register { result in
            switch result {
            case .success(let token):
                guard let key = Store.pushKeyText() else { return call.reject("no message key", "unavailable") }
                var answer: [String: Any] = ["transport": "apns", "token": token, "key": key, "environment": Push.environment]
                if let previous = Store.swapToken(token) { answer["previousToken"] = previous }
                call.resolve(answer)
            case .failure(let error):
                call.reject("no push token", "no_token", error)
            }
        }
    }

    /// What notifications need while the app is closed: the language, Communicator's address and the sources' names.
    @objc func configure(_ call: CAPPluginCall) {
        Store.configure(locale: call.getString("locale"), communicator: call.getString("communicator"), sources: call.getArray("sources"))
        call.resolve()
    }

    /// The message a notification tap opened the app on, once.
    @objc func takeOpened(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let id = Push.shared.takeOpened() {
                call.resolve(["id": id])
            } else {
                call.resolve()
            }
        }
    }

    // MARK: the Google account

    @objc func googleIdToken(_ call: CAPPluginCall) {
        let clientId = call.getString("clientId") ?? ""
        let interactive = call.getBool("interactive") ?? false
        DispatchQueue.main.async {
            GoogleAccount.idToken(server: clientId, interactive: interactive, presenting: self.bridge?.viewController) { result in
                switch result {
                case .success(let account):
                    call.resolve(["idToken": account.idToken, "email": account.email, "name": account.name])
                case .failure(let failure):
                    call.reject(failure.message, failure.code)
                }
            }
        }
    }

    /// Resolves with {code}, for the server (POST /auth/drive).
    @objc func authorizeDrive(_ call: CAPPluginCall) {
        let clientId = call.getString("clientId") ?? ""
        DispatchQueue.main.async {
            GoogleAccount.authorizeDrive(server: clientId, presenting: self.bridge?.viewController) { result in
                switch result {
                case .success(let code): call.resolve(["code": code])
                case .failure(let failure): call.reject(failure.message, failure.code)
                }
            }
        }
    }

    @objc func forgetGoogle(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            GoogleAccount.forget()
            call.resolve()
        }
    }

    // MARK: transcription in the background

    /// A shared clip to Eliezer (base), with the app's token, then awaited (Uploads).
    @objc func enqueueTranscription(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let uploadId = call.getString("uploadId") ?? ""
        let base = call.getString("base") ?? ""
        let token = call.getString("token") ?? ""
        guard Shares.find(id) != nil, !uploadId.isEmpty, base.hasPrefix("https://"), !token.isEmpty else {
            return call.reject("cannot enqueue", "bad_request")
        }
        Shares.markUpload(id, uploadId: uploadId)
        Uploads.shared.enqueueClip(
            shareId: id, base: base, token: token, uploadId: uploadId,
            origin: call.getString("origin") ?? "", title: call.getString("title") ?? "")
        call.resolve()
    }

    /// A shared recording too long for a clip, into My files on this site (base),
    /// signed in by the web view's cookie.
    @objc func uploadToTranscribe(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let base = call.getString("base") ?? ""
        guard Shares.find(id) != nil, base.hasPrefix("https://"), let host = URL(string: base)?.host else {
            return call.reject("cannot upload", "bad_request")
        }
        let language = call.getString("language") ?? "he"
        let saveAudio = call.getBool("saveAudio") ?? true
        DispatchQueue.main.async {
            guard let store = self.bridge?.webView?.configuration.websiteDataStore.httpCookieStore else {
                return call.reject("no web view", "bad_request")
            }
            // The web view keeps its cookies apart from the app's; the upload carries them over.
            store.getAllCookies { cookies in
                let ours = cookies.filter { cookie in
                    let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
                    return host == domain || host.hasSuffix("." + domain)
                }
                let cookie = HTTPCookie.requestHeaderFields(with: ours)["Cookie"] ?? ""
                if cookie.isEmpty {
                    Self.emit("fileUpload", ["id": id, "state": "signin"])
                } else {
                    Uploads.shared.enqueueFile(shareId: id, base: base, language: language, saveAudio: saveAudio, cookie: cookie)
                }
                call.resolve()
            }
        }
    }

    // MARK: shared files

    @objc func sharedFiles(_ call: CAPPluginCall) {
        call.resolve(["files": Shares.list()])
    }

    @objc func discardShared(_ call: CAPPluginCall) {
        Shares.discard(call.getString("id") ?? "")
        call.resolve()
    }

    /// Offers a shared file to other apps, under its own name.
    @objc func shareOn(_ call: CAPPluginCall) {
        guard let entry = Shares.find(call.getString("id") ?? "") else {
            return call.reject("not found", "not_found")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(entry.id, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let named = dir.appendingPathComponent(entry.name.isEmpty ? "recording" : entry.name)
        try? FileManager.default.removeItem(at: named)
        guard (try? FileManager.default.copyItem(at: entry.url, to: named)) != nil else {
            return call.reject("not found", "not_found")
        }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else { return call.reject("no screen", "not_found") }
            let sheet = UIActivityViewController(activityItems: [named], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = presenter.view
            presenter.present(sheet, animated: true)
            call.resolve()
        }
    }
}
