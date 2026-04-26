"""把 Service Account JSON 壓成單行寫進 scripts/.env 的 GOOGLE_CREDENTIALS。

用法 (從 scripts/ 目錄):
  python fill_google_creds.py C:\\path\\to\\sa-key.json

不會把 key 內容印到 stdout。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent / ".env"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("用法: python fill_google_creds.py <path-to-sa.json>", file=sys.stderr)
        return 2

    sa_path = Path(argv[1]).expanduser()
    if not sa_path.exists():
        print(f"找不到 SA JSON 檔: {sa_path}", file=sys.stderr)
        return 1

    try:
        data = json.loads(sa_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"SA JSON 解析失敗: {e}", file=sys.stderr)
        return 1

    # 驗證必要欄位
    required = {"type", "project_id", "private_key", "client_email"}
    missing = required - set(data.keys())
    if missing:
        print(f"SA JSON 缺欄位: {sorted(missing)}", file=sys.stderr)
        return 1
    if data["type"] != "service_account":
        print(f"SA JSON type={data['type']!r},預期 'service_account'", file=sys.stderr)
        return 1

    compact = json.dumps(data, separators=(",", ":"), ensure_ascii=False)

    if not ENV_PATH.exists():
        print(f"找不到 {ENV_PATH}", file=sys.stderr)
        return 1

    env_text = ENV_PATH.read_text(encoding="utf-8")
    new_text, n = re.subn(
        r"(?m)^GOOGLE_CREDENTIALS=.*$",
        f"GOOGLE_CREDENTIALS={compact}",
        env_text,
        count=1,
    )
    if n == 0:
        # 沒找到既有那行,append 到檔尾
        if not env_text.endswith("\n"):
            env_text += "\n"
        new_text = env_text + f"GOOGLE_CREDENTIALS={compact}\n"

    ENV_PATH.write_text(new_text, encoding="utf-8")
    print(f"OK: 寫入 {ENV_PATH}")
    print(f"     SA email = {data['client_email']}")
    print(f"     project  = {data['project_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
