package ai.ivrit.app;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opens a message Communicator sealed for this device (see fcm.js there):
 * AES-256-GCM with the key this device registered, laid out as a 12-byte
 * nonce, then the ciphertext with its 16-byte tag. Firebase only ever relays
 * the sealed form.
 */
final class Sealed {
    private Sealed() {}

    static String open(byte[] key, byte[] sealed) throws GeneralSecurityException {
        if (sealed.length < 12 + 16) throw new GeneralSecurityException("too short");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, sealed, 0, 12));
        return new String(cipher.doFinal(sealed, 12, sealed.length - 12), StandardCharsets.UTF_8);
    }
}
