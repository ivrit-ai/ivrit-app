"""The app's own sign-in sessions.

Signing in is Google's (on the phone, with this site's OAuth client; or here, on the
web), but a Google ID token lasts an hour, so it is exchanged, once, for a session
token signed with the app's own key: it names the same Google account (sub, email)
and lasts SESSION_DAYS, renewed while the app is used, so an active user stays signed
in, as with Gmail. Eliezer and Communicator accept it by checking it against the
public key at /.well-known/jwks.json.

APP_SESSION_KEY is the private key (PKCS#8 PEM, RSA). The key id is derived from the
key itself exactly as the app's earlier Node server did, so sessions it issued remain
valid here.
"""

import base64
import hashlib
import time
from typing import Optional

import jwt
from cryptography.hazmat.primitives import serialization

SESSION_DAYS = 90
# The audience of session tokens: what Eliezer and Communicator check for.
SESSION_AUDIENCE = "ivrit-app"
GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _uint(n: int) -> str:
    return _b64url(n.to_bytes((n.bit_length() + 7) // 8, "big"))


class Sessions:
    def __init__(self, issuer: str, google_client_id: str, private_key_pem: str, google_jwks_url: Optional[str] = None):
        self.issuer = issuer.rstrip("/")
        self.google_client_id = google_client_id
        self.key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
        numbers = self.key.public_key().public_numbers()
        n, e = _uint(numbers.n), _uint(numbers.e)
        # The key's own fingerprint names it, so a new key is told apart from the old.
        self.kid = _b64url(hashlib.sha256(n.encode()).digest())[:16]
        self.jwks = {"keys": [{"kty": "RSA", "n": n, "e": e, "kid": self.kid, "alg": "RS256", "use": "sig"}]}
        self._google = jwt.PyJWKClient(google_jwks_url or GOOGLE_JWKS_URL, cache_keys=True, lifespan=3600)

    def issue(self, sub: str, email: str, name: Optional[str] = None) -> dict:
        now = int(time.time())
        claims = {
            "email": email,
            "iss": self.issuer,
            "aud": SESSION_AUDIENCE,
            "sub": sub,
            "iat": now,
            "exp": now + SESSION_DAYS * 86400,
        }
        if name:
            claims["name"] = name
        token = jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": self.kid, "typ": "JWT"})
        return {"token": token, "expires_at": int(time.time() * 1000) + SESSION_DAYS * 86_400_000}

    def from_google(self, id_token: str) -> dict:
        """A Google ID token, for this site's client and a verified address, into a
        session. Blocking (fetches Google's keys): call it off the event loop."""
        key = self._google.get_signing_key_from_jwt(id_token).key
        claims = jwt.decode(
            id_token, key, algorithms=["RS256"], audience=self.google_client_id, issuer=GOOGLE_ISSUERS,
            leeway=60, options={"require": ["sub", "email", "exp", "iat"]},
        )
        if claims.get("email_verified") is not True:
            raise jwt.InvalidTokenError("unverified email")
        return self.issue(str(claims["sub"]), str(claims["email"]), claims.get("name"))

    def renew(self, token: str) -> dict:
        """A session still valid, renewed for another SESSION_DAYS."""
        claims = jwt.decode(
            token, self.key.public_key(), algorithms=["RS256"], audience=SESSION_AUDIENCE, issuer=self.issuer,
            options={"require": ["sub", "email", "exp"]},
        )
        return self.issue(claims["sub"], claims["email"], claims.get("name"))

    def verify(self, token: str) -> dict:
        """The claims of a valid session, or raises."""
        return jwt.decode(
            token, self.key.public_key(), algorithms=["RS256"], audience=SESSION_AUDIENCE, issuer=self.issuer,
            options={"require": ["sub", "email", "exp"]},
        )
