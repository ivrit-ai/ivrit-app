// The app's own sign-in session. Signing in is Google's (on the phone, with
// transcribe.ivrit.ai's OAuth client), but a Google ID token lasts an hour, so
// it is exchanged here, once, for a session token signed with the app's own key:
// it names the same Google account (sub, email) and lasts SESSION_DAYS, renewed
// while the app is used, so an active user stays signed in, as with Gmail.
// Eliezer and Communicator accept it by checking it against the public key at
// /.well-known/jwks.json.
//
// APP_SESSION_KEY is the private key (PKCS#8 PEM, RSA). Without it, or without
// GOOGLE_CLIENT_ID, signing in is off.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";

export const SESSION_DAYS = 90;
// The audience of session tokens: what Eliezer and Communicator check for.
export const SESSION_AUDIENCE = "ivrit-app";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function createSessions({ issuer, googleClientId, privateKeyPem, googleJwksUrl }) {
  if (!privateKeyPem || !googleClientId) return null;
  const privateKey = createPrivateKey(privateKeyPem);
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  // The key's own fingerprint names it, so a new key is told apart from the old.
  const kid = createHash("sha256").update(publicJwk.n).digest("base64url").slice(0, 16);
  const jwks = { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] };
  const google = createRemoteJWKSet(new URL(googleJwksUrl || "https://www.googleapis.com/oauth2/v3/certs"));

  async function issue({ sub, email, name }) {
    const token = await new SignJWT({ email, name: name ?? undefined })
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(SESSION_AUDIENCE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_DAYS}d`)
      .sign(privateKey);
    return { token, expires_at: Date.now() + SESSION_DAYS * 86_400_000 };
  }

  return {
    jwks,
    // A Google ID token, for the app's client and a verified address, into a session.
    async fromGoogle(idToken) {
      const { payload } = await jwtVerify(idToken, google, {
        issuer: GOOGLE_ISSUERS,
        audience: googleClientId,
        algorithms: ["RS256"],
        clockTolerance: 60,
        requiredClaims: ["sub", "email"],
      });
      if (payload.email_verified !== true) throw new Error("unverified email");
      return issue({ sub: String(payload.sub), email: String(payload.email), name: payload.name ? String(payload.name) : null });
    },
    // A session still valid, renewed for another SESSION_DAYS.
    async renew(token) {
      const { payload } = await jwtVerify(token, createLocalJwks(jwks), {
        issuer,
        audience: SESSION_AUDIENCE,
        algorithms: ["RS256"],
      });
      return issue({ sub: payload.sub, email: payload.email, name: payload.name ?? null });
    },
  };
}

// jose wants a key resolver; ours is one key, known locally.
function createLocalJwks(jwks) {
  return async (header) => {
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error("unknown key");
    return createPublicKey({ key: jwk, format: "jwk" });
  };
}
