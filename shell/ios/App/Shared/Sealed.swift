import CryptoKit
import Foundation

/// Opens a message Communicator sealed for this device (see apns.js and fcm.js
/// there): AES-256-GCM with the key this device registered, laid out as a
/// 12-byte nonce, then the ciphertext with its 16-byte tag. Apple only ever
/// relays the sealed form.
enum Sealed {
    struct Unreadable: Error {}

    static func open(key: Data, sealed: Data) throws -> String {
        guard sealed.count >= 12 + 16 else { throw Unreadable() }
        let bytes = Data(sealed)
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: bytes.prefix(12)),
            ciphertext: bytes.dropFirst(12).dropLast(16),
            tag: bytes.suffix(16)
        )
        let plain = try AES.GCM.open(box, using: SymmetricKey(data: key))
        guard let text = String(data: plain, encoding: .utf8) else { throw Unreadable() }
        return text
    }
}
