#!/usr/bin/env python3
"""Signing for the iPhone app, through the App Store Connect API (the same key
CI uploads with), instead of Xcode's automatic signing, which needs a
registered device or an Admin key's cloud certificate.

    ios-signing.py certificate OUT.p12
        Once, on a trusted machine: a new private key and an Apple Distribution
        certificate for it, written as a .p12 (password in OUT.p12.password).
        Both go to CI's secrets; the private key is never printed.

    ios-signing.py profiles
        In CI: the app's and its extensions' identifiers (made if missing), and
        fresh App Store provisioning profiles for them with that certificate,
        installed for Xcode. Prints the build settings that pick them.

Needs ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID; profiles also IOS_CERT_ID (the
certificate's id, which `certificate` prints). Needs pyjwt and cryptography.
"""

import base64
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

API = "https://api.appstoreconnect.apple.com/v1"

# Target → bundle id, and the capabilities each needs (shell/ios/App/project.yml).
TARGETS = {
    "APP": ("ai.ivrit", ["APP_GROUPS", "PUSH_NOTIFICATIONS", "ASSOCIATED_DOMAINS"]),
    "NOTIFICATION_SERVICE": ("ai.ivrit.NotificationService", ["APP_GROUPS"]),
    "SHARE_EXTENSION": ("ai.ivrit.ShareExtension", ["APP_GROUPS"]),
}


def token() -> str:
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
        Path(os.environ["ASC_KEY_PATH"]).read_text(),
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"},
    )


def call(method: str, path: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        path if path.startswith("http") else API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"authorization": f"Bearer {token()}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        errors = json.loads(e.read() or b"{}").get("errors", [{}])
        sys.exit(f"{method} {path}: {e.code} {errors[0].get('code')}: {errors[0].get('detail')}")


def certificate(out: str) -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ivrit.ai CI"), x509.NameAttribute(NameOID.COUNTRY_NAME, "IL")]))
        .sign(key, hashes.SHA256())
    )
    made = call("POST", "/certificates", {"data": {"type": "certificates", "attributes": {
        "certificateType": "DISTRIBUTION",
        "csrContent": base64.b64encode(csr.public_bytes(serialization.Encoding.DER)).decode(),
    }}})["data"]
    cert = x509.load_der_x509_certificate(base64.b64decode(made["attributes"]["certificateContent"]))
    password = secrets.token_urlsafe(24)
    # Legacy (SHA-1, 3DES) encryption: macOS's `security import` reads no other.
    encryption = (
        serialization.PrivateFormat.PKCS12.encryption_builder()
        .kdf_rounds(2048)
        .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
        .hmac_hash(hashes.SHA1())
        .build(password.encode())
    )
    data = pkcs12.serialize_key_and_certificates(b"ivrit.ai CI", key, cert, None, encryption)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, data)
    os.close(fd)
    fd = os.open(out + ".password", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, password.encode())
    os.close(fd)
    print(f"certificate {made['id']} ({made['attributes']['name']}, expires {made['attributes']['expirationDate'][:10]}) -> {out}")


def bundle_id(identifier: str, capabilities: list[str]) -> str:
    found = call("GET", f"/bundleIds?filter[identifier]={urllib.parse.quote(identifier)}&include=bundleIdCapabilities&limit=20")
    match = [d for d in found["data"] if d["attributes"]["identifier"] == identifier]
    if match:
        bid = match[0]["id"]
        have = {i["attributes"]["capabilityType"] for i in found.get("included", []) if i["type"] == "bundleIdCapabilities"
                and i["id"].startswith(bid)}
    else:
        name = "ivritai " + identifier.rsplit(".", 1)[-1] if identifier.count(".") > 1 else "ivritai"
        bid = call("POST", "/bundleIds", {"data": {"type": "bundleIds", "attributes": {
            "identifier": identifier, "name": name, "platform": "IOS"}}})["data"]["id"]
        have = set()
        print(f"registered {identifier}")
    for capability in capabilities:
        if capability not in have:
            call("POST", "/bundleIdCapabilities", {"data": {"type": "bundleIdCapabilities",
                "attributes": {"capabilityType": capability},
                "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": bid}}}}})
            print(f"{identifier}: enabled {capability}")
    return bid


def profiles() -> None:
    cert_id = os.environ["IOS_CERT_ID"]
    installed = Path.home() / "Library/MobileDevice/Provisioning Profiles"
    installed.mkdir(parents=True, exist_ok=True)
    settings = []
    for target, (identifier, capabilities) in TARGETS.items():
        bid = bundle_id(identifier, capabilities)
        # Apple's names take no punctuation.
        name = "ivritai CI " + identifier.replace(".", " ")
        # Made fresh each time, so it always has the identifier's current capabilities.
        for old in call("GET", f"/profiles?filter[name]={urllib.parse.quote(name)}&limit=20")["data"]:
            call("DELETE", f"/profiles/{old['id']}")
        made = call("POST", "/profiles", {"data": {"type": "profiles",
            "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
            "relationships": {
                "bundleId": {"data": {"type": "bundleIds", "id": bid}},
                "certificates": {"data": [{"type": "certificates", "id": cert_id}]},
            }}})["data"]
        content = base64.b64decode(made["attributes"]["profileContent"])
        (installed / f"{made['attributes']['uuid']}.mobileprovision").write_bytes(content)
        # The App Group must be assigned to the identifier on developer.apple.com
        # (the API cannot): without it the profile lacks the group, and signing fails.
        start, end = content.find(b"<?xml"), content.find(b"</plist>") + len(b"</plist>")
        groups = b"group.ai.ivrit" in content[start:end]
        print(f"{identifier}: profile {made['attributes']['uuid']}{'' if groups else '  (no App Group: assign group.ai.ivrit to it)'}")
        settings.append(f'IVRIT_PROFILE_{target}="{name}"')
    Path(os.environ.get("IOS_SIGNING_ENV", "/dev/stdout")).write_text("\n".join(settings) + "\n")


if __name__ == "__main__":
    if sys.argv[1:2] == ["certificate"] and len(sys.argv) == 3:
        certificate(sys.argv[2])
    elif sys.argv[1:] == ["profiles"]:
        profiles()
    else:
        sys.exit(__doc__)
