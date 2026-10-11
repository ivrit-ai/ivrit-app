import AVFoundation
import Foundation
import UniformTypeIdentifiers

/// Audio and video shared into the app from WhatsApp or anywhere else. The
/// share extension copies each into the App Group's folder, since the sender's
/// file goes away with the share, where it waits, with its name and type, until
/// the user sends it on or discards it. The iPhone side of Android's Shares.
enum Shares {
    struct Entry {
        let id: String
        let url: URL
        let name: String
        let type: String
        let durationMs: Int64
        let origin: String
        var uploadId: String
    }

    /// Set by the share extension, taken by the app: files are waiting.
    static let pendingKey = "shared_pending"
    /// Posted (Darwin) by the share extension, for an app that is running.
    static let darwinName = "ai.ivrit.app.shared"

    static var dir: URL {
        let dir = Store.container.appendingPathComponent("shared", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func valid(_ id: String) -> Bool {
        id.range(of: #"^\d+-\d+$"#, options: .regularExpression) != nil
    }

    private static func metaURL(_ id: String) -> URL { dir.appendingPathComponent(id + ".json") }

    // MARK: taking a share in (the share extension)

    /// Copies one attachment in under id. False when it could not be read.
    static func keep(_ provider: NSItemProvider, as type: UTType, id: String) async -> Bool {
        let target = dir.appendingPathComponent(id)
        let name: String? = await withCheckedContinuation { done in
            // The file exists only during this callback, so it is copied here.
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else { return done.resume(returning: nil) }
                do {
                    try? FileManager.default.removeItem(at: target)
                    try FileManager.default.copyItem(at: url, to: target)
                    done.resume(returning: provider.suggestedName.flatMap { named($0, like: url) } ?? url.lastPathComponent)
                } catch {
                    done.resume(returning: nil)
                }
            }
        }
        guard let name else { return false }
        let ext = (name as NSString).pathExtension.lowercased()
        let meta: [String: Any] = [
            "name": name,
            "type": mimeType(ext: ext, type: type),
            "durationMs": await durationMs(target),
            "origin": originOf(name),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: meta) else { return false }
        return FileManager.default.createFile(atPath: metaURL(id).path, contents: data)
    }

    /// A sender's suggested name, given the file's extension when it lacks one.
    private static func named(_ suggested: String, like url: URL) -> String {
        (suggested as NSString).pathExtension.isEmpty && !url.pathExtension.isEmpty
            ? suggested + "." + url.pathExtension
            : suggested
    }

    private static func mimeType(ext: String, type: UTType) -> String {
        // WhatsApp's voice notes: Ogg Opus, which iOS has no type of its own for.
        if ext == "opus" || ext == "ogg" { return "audio/ogg" }
        return UTType(filenameExtension: ext)?.preferredMIMEType ?? type.preferredMIMEType ?? "application/octet-stream"
    }

    /// Where a shared recording came from, for the app to show: "whatsapp", or
    /// "" when unknown. iOS does not tell a share extension which app shared, so
    /// this goes by WhatsApp's names for what it exports: voice notes as
    /// "PTT-<date>-WA<n>.opus", other audio as "AUD-<date>-WA<n>…".
    static func originOf(_ name: String) -> String {
        let lower = name.lowercased()
        if lower.hasPrefix("ptt-") || lower.range(of: #"-wa\d{4}"#, options: .regularExpression) != nil || lower.hasSuffix(".opus") {
            return "whatsapp"
        }
        return ""
    }

    /// How long the recording is, or -1 if it cannot be read: the app sends short ones to Eliezer.
    private static func durationMs(_ url: URL) async -> Int64 {
        let asset = AVURLAsset(url: url)
        guard let duration = try? await asset.load(.duration), duration.isNumeric else { return -1 }
        return Int64((duration.seconds * 1000).rounded())
    }

    /// Tells the app files are waiting: now, if it is running, and when it next opens.
    static func announce() {
        Store.defaults.set(true, forKey: pendingKey)
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(darwinName as CFString), nil, nil, true)
    }

    // MARK: the app's side

    static func find(_ id: String) -> Entry? {
        guard valid(id) else { return nil }
        let url = dir.appendingPathComponent(id)
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: metaURL(id)),
              let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return Entry(
            id: id,
            url: url,
            name: meta["name"] as? String ?? "",
            type: meta["type"] as? String ?? "application/octet-stream",
            durationMs: (meta["durationMs"] as? NSNumber)?.int64Value ?? -1,
            origin: meta["origin"] as? String ?? "",
            uploadId: meta["uploadId"] as? String ?? ""
        )
    }

    static func size(_ entry: Entry) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: entry.url.path))?[.size] as? NSNumber)?.int64Value ?? 0
    }

    static func list() -> [[String: Any]] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { !$0.hasSuffix(".json") }.sorted().compactMap(find).map { entry in
            [
                "id": entry.id,
                "name": entry.name,
                "type": entry.type,
                "size": size(entry),
                "durationMs": entry.durationMs,
                "origin": entry.origin,
                "uploadId": entry.uploadId,
            ]
        }
    }

    /// Marks a file as handed to the uploads, under the page's upload id.
    static func markUpload(_ id: String, uploadId: String) {
        guard valid(id),
              let data = try? Data(contentsOf: metaURL(id)),
              var meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        meta["uploadId"] = uploadId
        if let out = try? JSONSerialization.data(withJSONObject: meta) { try? out.write(to: metaURL(id), options: .atomic) }
    }

    static func discard(_ id: String) {
        guard valid(id) else { return }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(id))
        try? FileManager.default.removeItem(at: metaURL(id))
    }
}
