import Foundation
import UserNotifications

/// Opens Communicator's messages before iOS shows them, even with the app closed:
/// the iPhone side of Android's PushService. Apple relays only the sealed
/// payload ("p") under a placeholder ("New message", from the app's
/// Localizable.strings); this decrypts it with the device's key, shows the real
/// source, title and text, with the source's logo, and acks it. If the message
/// cannot be opened, or time runs out, the placeholder (or what was ready) shows.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var deliver: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            return contentHandler(request.content)
        }
        lock.withLock {
            deliver = contentHandler
            self.content = content
        }
        guard let sealed = content.userInfo["p"] as? String,
              let data = Data(base64Encoded: sealed),
              let key = Store.pushKey(create: false),
              let text = try? Sealed.open(key: key, sealed: data),
              let payload = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else {
            // Sealed for a key this install no longer has (reinstalled): the next
            // registration sends the new key.
            return finish()
        }
        Message.fill(content, from: payload)
        Task {
            async let logo = Message.logo(payload["sid"] as? String)
            async let acked: Void = Message.ack(payload)
            let attachment = await logo
            _ = await acked
            if let attachment { lock.withLock { content.attachments = [attachment] } }
            finish()
        }
    }

    override func serviceExtensionTimeWillExpire() {
        finish()
    }

    /// Hands iOS the content once, whichever comes first.
    private func finish() {
        let (handler, content) = lock.withLock { () -> (((UNNotificationContent) -> Void)?, UNNotificationContent?) in
            defer { deliver = nil }
            return (deliver, self.content?.copy() as? UNNotificationContent)
        }
        if let handler, let content { handler(content) }
    }
}

/// One message as Communicator sends it (payload.js there): i id, d device, k
/// ack key, s source, sid source id, t title, st subtitle, b body, ts time, u url.
enum Message {
    static func fill(_ content: UNMutableNotificationContent, from p: [String: Any]) {
        let sourceId = p["sid"] as? String
        let name = Store.sourceName(sourceId, fallback: p["s"] as? String ?? "ivrit.ai")
        let title = p["t"] as? String ?? ""
        // The source leads: on a locked phone the title is often all that shows.
        content.title = title.isEmpty ? name : "\(name) · \(title)"
        content.subtitle = p["st"] as? String ?? ""
        content.body = p["b"] as? String ?? ""
        content.threadIdentifier = sourceId.map { "source:\($0)" } ?? ""
        content.userInfo = ["id": p["i"] as? String ?? ""]
        content.sound = .default
        content.interruptionLevel = .active
    }

    /// The source's logo from Communicator, or nil: a message never waits long on its picture.
    static func logo(_ sourceId: String?) async -> UNNotificationAttachment? {
        guard let sourceId,
              let encoded = sourceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))),
              let url = URL(string: "\(Store.communicator)/api/sources/\(encoded)/icon.png") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 4
        guard let (file, response) = try? await URLSession.shared.download(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        // An attachment is known by its file's extension.
        let png = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        guard (try? FileManager.default.moveItem(at: file, to: png)) != nil else { return nil }
        return try? UNNotificationAttachment(identifier: "logo", url: png)
    }

    /// Settles the delivery, as the service worker and Android do. Best effort:
    /// the app syncs on open regardless.
    static func ack(_ p: [String: Any]) async {
        guard let i = p["i"] as? String, let d = p["d"] as? String, let k = p["k"] as? String,
              let url = URL(string: "\(Store.communicator)/api/ack"),
              let body = try? JSONSerialization.data(withJSONObject: ["i": i, "d": d, "k": k]) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body
        _ = try? await URLSession.shared.data(for: request)
    }
}
