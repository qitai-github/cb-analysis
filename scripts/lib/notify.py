# -*- coding: utf-8 -*-
"""排程失敗告警 — 只發給管理員(TG_CB_CHAT_ID;沒設就 fallback TG_CHAT_ID),不廣播給白名單用戶。

用法: from lib import notify; notify.alert('週報失敗', '原因…')
沒設定 token/chat_id 時只印出訊息,絕不拋例外、不擋主流程。
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load_env():
    try:
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).resolve().parent.parent / '.env', override=False)
    except Exception:
        pass


def alert(title, body=''):
    """回傳是否真的送出。"""
    msg = '⚠️ %s\n%s' % (title, body)
    print(msg, file=sys.stderr)
    try:
        _load_env()
        from lib import telegram
        token = os.environ.get('TG_CB_BOT_TOKEN', '').strip() or None
        chat = os.environ.get('TG_CB_CHAT_ID', '').strip() or None
        return telegram.send(msg, token=token, chat_id=chat, parse_mode='')
    except Exception as e:  # noqa: BLE001
        print('告警送出失敗: %s' % e, file=sys.stderr)
        return False
