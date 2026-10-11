import UIKit
import UniformTypeIdentifiers
import UserNotifications

/// "Share to ivrit.ai" for audio and video, from WhatsApp or anywhere else. The
/// files are kept in the App Group (Shares), where the app takes them the next
/// time it is open, as Android's share intent does: a clip goes to Eliezer, a
/// longer recording to My files. An extension cannot open its app, so it says
/// where the recording went, and leaves a notification that opens the app on it.
final class ShareViewController: UIViewController {
    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        let card = UIStackView(arrangedSubviews: [spinner, label])
        card.axis = .vertical
        card.spacing = 12
        card.alignment = .center
        card.isLayoutMarginsRelativeArrangement = true
        card.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 24, leading: 24, bottom: 24, trailing: 24)
        card.backgroundColor = .systemBackground
        card.layer.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false
        label.text = Self.text("saving")
        label.font = .preferredFont(forTextStyle: .headline)
        label.textAlignment = .center
        label.numberOfLines = 0
        spinner.startAnimating()
        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
            card.widthAnchor.constraint(greaterThanOrEqualToConstant: 240),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { @MainActor in
            let kept = await keep()
            spinner.stopAnimating()
            spinner.isHidden = true
            label.text = Self.text(kept > 0 ? "saved" : "nothing")
            if kept > 0 {
                Shares.announce()
                await remind()
            }
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    /// Every audio or video attachment, kept under one share's ids (time-index, as on Android).
    private func keep() async -> Int {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let stamp = Int64(Date().timeIntervalSince1970 * 1000)
        var index = 0
        var kept = 0
        for item in items {
            for provider in item.attachments ?? [] {
                guard let type = Self.mediaType(provider) else { continue }
                if await Shares.keep(provider, as: type, id: "\(stamp)-\(index)") { kept += 1 }
                index += 1
            }
        }
        return kept
    }

    private static func mediaType(_ provider: NSItemProvider) -> UTType? {
        let types = provider.registeredTypeIdentifiers.compactMap(UTType.init)
        return types.first { $0.conforms(to: .audio) || $0.conforms(to: .movie) || $0.preferredFilenameExtension == "opus" }
    }

    /// A notification that opens the app on what was shared: tapping it is the
    /// way back into the app from here.
    private func remind() async {
        let center = UNUserNotificationCenter.current()
        guard await center.notificationSettings().authorizationStatus == .authorized else { return }
        let content = UNMutableNotificationContent()
        content.title = "ivrit.ai"
        content.body = Self.text("waiting")
        content.userInfo = ["kind": "shared"]
        content.threadIdentifier = "shared"
        try? await center.add(UNNotificationRequest(identifier: "shared", content: content, trigger: nil))
    }

    private static func text(_ key: String) -> String {
        NSLocalizedString(key, comment: "")
    }
}
