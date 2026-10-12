import BackgroundTasks
import UIKit
import UserNotifications

/// Shared recordings on their way out, in the background: iOS carries the
/// uploads on (a background URLSession) after the app is closed, relaunching it
/// to hear how they went, and retries them later when the network fails. The
/// iPhone side of Android's TranscribeWorker and FileUploadWorker.
///
/// - A clip goes to Eliezer (POST /app/v1/jobs) with the app's session token and
///   the page's upload id, so a re-send is the same job; then its transcript is
///   awaited, and shown as a notification if the app is not open.
/// - A longer recording goes to the app's own server (POST /upload) as the
///   Transcribe view would send it, signed in with the web view's cookie, into My
///   files.
///
/// iOS gives an app in the background only moments, not Android's minutes, so a
/// transcript is awaited briefly after its upload, then at the times iOS allows
/// background refreshes (Self.checkTask), and in any case by the page whenever the
/// app opens.
final class Uploads: NSObject, URLSessionDataDelegate {
    static let shared = Uploads()
    static let checkTask = "ai.ivrit.jobs"
    private static let maxAttempts = 8
    private static let pollSeconds: UInt64 = 3
    /// What a header may carry unescaped: ASCII only (.alphanumerics would let Hebrew through).
    private static let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~")
    /// How long a transcript is waited for in the background, at most.
    private static let jobLifetime: TimeInterval = 60 * 60

    /// From the app delegate, when iOS relaunched the app for the session's events.
    var backgroundCompletion: (() -> Void)?

    private struct Job: Codable {
        var kind: String // "clip" | "file"
        var shareId: String
        var base: String
        var uploadId = ""
        var token = ""
        var origin = ""
        var title = ""
        var cookie = ""
        var boundary = ""
        var attempt = 0
    }

    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private var bodies: [Int: Data] = [:]

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: "ai.ivrit.uploads")
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        return URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }()

    /// Reconnects to the session at launch, so uploads that finished meanwhile report in.
    func resume() {
        _ = session
    }

    // MARK: starting

    func enqueueClip(shareId: String, base: String, token: String, uploadId: String, origin: String, title: String) {
        start(Job(kind: "clip", shareId: shareId, base: base, uploadId: uploadId, token: token, origin: origin, title: title))
    }

    func enqueueFile(shareId: String, base: String, language: String, saveAudio: Bool, cookie: String) {
        guard let entry = Shares.find(shareId) else { return }
        let boundary = "----ivrit" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        guard Self.writeMultipart(entry, boundary: boundary, fields: ["language": language, "save_audio": saveAudio ? "true" : "false"]) else {
            return IvritNativePlugin.emit("fileUpload", ["id": shareId, "state": "failed", "error": "unreadable"])
        }
        start(Job(kind: "file", shareId: shareId, base: base, cookie: cookie, boundary: boundary))
    }

    private static func bodyURL(_ shareId: String) -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("uploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(shareId + ".multipart")
    }

    /// The form the Transcribe view posts, as a file: a background session uploads only from files.
    private static func writeMultipart(_ entry: Shares.Entry, boundary: String, fields: [String: String]) -> Bool {
        var head = ""
        for (name, value) in fields.sorted(by: { $0.key < $1.key }) {
            head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n"
        }
        let filename = entry.name.replacingOccurrences(of: "\"", with: "'")
        head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: \(entry.type)\r\n\r\n"
        let url = bodyURL(entry.id)
        guard FileManager.default.createFile(atPath: url.path, contents: Data(head.utf8)),
              let out = try? FileHandle(forWritingTo: url),
              let input = try? FileHandle(forReadingFrom: entry.url) else { return false }
        defer {
            try? out.close()
            try? input.close()
        }
        do {
            try out.seekToEnd()
            while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
                try out.write(contentsOf: chunk)
            }
            try out.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
            return true
        } catch {
            return false
        }
    }

    private func start(_ job: Job, after delay: TimeInterval = 0) {
        guard let entry = Shares.find(job.shareId), let base = URL(string: job.base) else { return }
        var request: URLRequest
        let file: URL
        if job.kind == "clip" {
            request = URLRequest(url: base.appendingPathComponent("app/v1/jobs"))
            request.setValue(entry.type, forHTTPHeaderField: "Content-Type")
            request.setValue(entry.name.addingPercentEncoding(withAllowedCharacters: Self.unreserved) ?? "", forHTTPHeaderField: "X-Filename")
            request.setValue(job.uploadId, forHTTPHeaderField: "X-Upload-Id")
            if !entry.origin.isEmpty { request.setValue(entry.origin, forHTTPHeaderField: "X-Origin") }
            request.setValue("Bearer \(job.token)", forHTTPHeaderField: "Authorization")
            file = entry.url
        } else {
            request = URLRequest(url: base.appendingPathComponent("upload"))
            request.setValue("multipart/form-data; boundary=\(job.boundary)", forHTTPHeaderField: "Content-Type")
            request.setValue(job.cookie, forHTTPHeaderField: "Cookie")
            request.setValue(job.base, forHTTPHeaderField: "Origin")
            file = Self.bodyURL(job.shareId)
        }
        request.httpMethod = "POST"
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = (try? JSONEncoder().encode(job)).flatMap { String(data: $0, encoding: .utf8) }
        if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
        task.resume()
    }

    // MARK: hearing back

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        bodies[dataTask.taskIdentifier, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = bodies.removeValue(forKey: task.taskIdentifier) ?? Data()
        guard let description = task.taskDescription,
              let job = try? JSONDecoder().decode(Job.self, from: Data(description.utf8)) else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if (error as NSError?)?.code == NSURLErrorCancelled { return }
        if error != nil || status == 0 { return retry(job) }
        if job.kind == "clip" {
            clipAnswered(job, status: status, body: body)
        } else {
            fileAnswered(job, status: status, body: body)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.backgroundCompletion?()
            self.backgroundCompletion = nil
        }
    }

    /// Again later, backing off, as Android's WorkManager does; given up after a few tries
    /// (the file stays, and the page offers it again).
    private func retry(_ job: Job) {
        guard job.attempt + 1 < Self.maxAttempts else { return }
        var next = job
        next.attempt += 1
        start(next, after: 30 * pow(2, Double(job.attempt)))
    }

    private func clipAnswered(_ job: Job, status: Int, body: Data) {
        switch status {
        case 200, 202:
            guard let answer = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let jobId = answer["job_id"] as? String else { return retry(job) }
            Jobs.add(job.uploadId, Jobs.Entry(jobId: jobId, base: job.base, token: job.token, title: job.title, origin: job.origin, since: Date()))
            Shares.discard(job.shareId)
            IvritNativePlugin.emit("transcription", ["uploadId": job.uploadId, "state": "queued"])
            watch(job.uploadId)
        case 401:
            // The token ran out before the network came back; the page sends a
            // fresh one the next time the app opens. The file stays.
            IvritNativePlugin.emit("transcription", ["uploadId": job.uploadId, "state": "signin"])
        case 429, 500...:
            retry(job)
        default:
            // Refused for good (too large, not audio): nothing to retry.
            Shares.discard(job.shareId)
            IvritNativePlugin.emit("transcription", ["uploadId": job.uploadId, "state": "failed", "error": status == 413 ? "too_large" : "unsupported"])
        }
    }

    private func fileAnswered(_ job: Job, status: Int, body: Data) {
        if status == 401 {
            return IvritNativePlugin.emit("fileUpload", ["id": job.shareId, "state": "signin"])
        }
        if status == 429 || status >= 500 { return retry(job) }
        try? FileManager.default.removeItem(at: Self.bodyURL(job.shareId))
        Shares.discard(job.shareId)
        guard status == 200 else {
            return IvritNativePlugin.emit("fileUpload", ["id": job.shareId, "state": "failed", "error": String(decoding: body, as: UTF8.self)])
        }
        // The server answers as it goes: transcoding, then queued (or why not).
        var error: String?
        var queued = false
        for line in String(decoding: body, as: UTF8.self).split(separator: "\n") {
            guard let event = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            if event["type"] as? String == "transcoding_complete" { queued = true }
            if event["type"] as? String == "error" { error = event["i18n_key"] as? String ?? event["error"] as? String ?? "failed" }
            if queued || error != nil { break }
        }
        var data: [String: Any] = ["id": job.shareId, "state": queued ? "queued" : "failed"]
        if !queued { data["error"] = error ?? "failed" }
        IvritNativePlugin.emit("fileUpload", data)
    }

    // MARK: awaiting transcripts

    /// Watches a clip's job for as long as iOS lets the app run: minutes while it
    /// is open, moments in the background; then leaves the rest to background refreshes.
    func watch(_ uploadId: String) {
        Task {
            let task = await MainActor.run { UIApplication.shared.beginBackgroundTask(withName: "transcript") }
            let active = await MainActor.run { UIApplication.shared.applicationState == .active }
            let until = Date().addingTimeInterval(active ? 240 : 25)
            while Date() < until {
                if await check(uploadId) { break }
                try? await Task.sleep(nanoseconds: Self.pollSeconds * 1_000_000_000)
            }
            await MainActor.run { UIApplication.shared.endBackgroundTask(task) }
            Self.scheduleCheck()
        }
    }

    /// One look at a job at Eliezer; true once it is settled (or no longer ours to follow).
    private func check(_ uploadId: String) async -> Bool {
        guard let job = Jobs.get(uploadId) else { return true }
        if Date().timeIntervalSince(job.since) > Self.jobLifetime {
            Jobs.remove(uploadId)
            return true
        }
        guard let url = URL(string: job.base)?.appendingPathComponent("app/v1/jobs/\(job.jobId)") else { return true }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(job.token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let status = (response as? HTTPURLResponse)?.statusCode else { return false }
        if status == 401 || status == 404 {
            // The app picks it up on open.
            Jobs.remove(uploadId)
            return true
        }
        guard status == 200, let answer = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        let state = answer["status"] as? String ?? ""
        if state == "queued" { return false }
        let active = await MainActor.run { UIApplication.shared.applicationState == .active }
        if state == "done" && !active {
            await Self.notifyTranscript(uploadId: uploadId, title: job.title, text: answer["text"] as? String ?? "")
        }
        var event: [String: Any] = ["uploadId": uploadId, "state": state]
        if let error = answer["error"] as? String { event["error"] = error }
        IvritNativePlugin.emit("transcription", event)
        Jobs.remove(uploadId)
        return true
    }

    /// A transcript ready while the app was closed. It opens on that message,
    /// whose id the page keeps as "app-" plus the upload id.
    private static func notifyTranscript(uploadId: String, title: String, text: String) async {
        let content = UNMutableNotificationContent()
        content.title = title.isEmpty ? "ivrit.ai" : title
        content.body = text
        content.sound = .default
        content.threadIdentifier = "transcripts"
        content.userInfo = ["id": "app-\(uploadId)"]
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "app-\(uploadId)", content: content, trigger: nil))
    }

    // MARK: background refreshes

    /// Registered once, before launching finishes (the app delegate).
    static func registerChecks() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: checkTask, using: nil) { task in
            Uploads.shared.runChecks(task)
        }
    }

    /// Asks iOS for a moment in a few minutes, while transcripts are awaited.
    static func scheduleCheck() {
        guard !Jobs.all().isEmpty else { return }
        let request = BGAppRefreshTaskRequest(identifier: checkTask)
        request.earliestBeginDate = Date().addingTimeInterval(2 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func runChecks(_ task: BGTask) {
        let work = Task {
            for uploadId in Jobs.all() {
                _ = await check(uploadId)
            }
            Self.scheduleCheck()
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
    }
}

/// Clips uploaded to Eliezer whose transcripts are still awaited, by upload id.
private enum Jobs {
    struct Entry: Codable {
        let jobId: String
        let base: String
        let token: String
        let title: String
        let origin: String
        let since: Date
    }

    private static let key = "ivrit_jobs"
    private static let lock = NSLock()

    private static func load() -> [String: Entry] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [:] }
        return (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    private static func save(_ jobs: [String: Entry]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(jobs), forKey: key)
    }

    static func add(_ uploadId: String, _ entry: Entry) {
        lock.withLock {
            var jobs = load()
            jobs[uploadId] = entry
            save(jobs)
        }
    }

    static func get(_ uploadId: String) -> Entry? {
        lock.withLock { load()[uploadId] }
    }

    static func remove(_ uploadId: String) {
        lock.withLock {
            var jobs = load()
            jobs.removeValue(forKey: uploadId)
            save(jobs)
        }
    }

    static func all() -> [String] {
        lock.withLock { Array(load().keys) }
    }
}
