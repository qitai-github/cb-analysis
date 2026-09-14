"""www.tpex.org.tw TLS 中繼憑證補丁。

2026-09 起 www.tpex.org.tw (含 openapi.tpex 子路徑,同一台主機) TLS handshake
只送出 leaf 憑證,不含 TWCA SSL Certification Authority 中繼憑證。certifi 內建
只有 root (TWCA CYBER Root CA),因此 requests 驗證會失敗:
  SSLCertVerificationError: unable to get local issuer certificate

解法:把中繼憑證 (scripts/certs/twca_ssl_sub_ca.pem) 併入 certifi bundle,
產生合併後的暫存 CA bundle,供 requests session 的 verify= 使用。
"""
from __future__ import annotations

import os
import tempfile
from typing import Optional

import certifi

_EXTRA_CA_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "certs", "twca_ssl_sub_ca.pem"
)
_MERGED_CA_BUNDLE: Optional[str] = None


def ca_bundle() -> str:
    """回傳可用於 requests(session.verify=...) 的 CA bundle 路徑。"""
    global _MERGED_CA_BUNDLE
    if _MERGED_CA_BUNDLE:
        return _MERGED_CA_BUNDLE
    if not os.path.isfile(_EXTRA_CA_FILE):
        return certifi.where()

    with open(certifi.where(), "r", encoding="utf-8") as f:
        base = f.read()
    with open(_EXTRA_CA_FILE, "r", encoding="utf-8") as f:
        extra = f.read()

    fd, path = tempfile.mkstemp(prefix="ca_bundle_", suffix=".pem")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(base)
        f.write("\n")
        f.write(extra)
    _MERGED_CA_BUNDLE = path
    return path
