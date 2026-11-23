"""Пост о выпуске NZ Chrome в Telegram-канал: примечания выпуска в разметке Telegram.

Зовётся из .github/workflows/telegram-release.yml.

Запуск руками, без отправки:
    RELEASE_BODY="$(cat docs/release-notes.md)" RELEASE_TAG=v0.1.0 python3 tools/telegram/post_release.py --dry-run
"""

import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

LIMIT = 4096
FOOTER = "## Чем это собрано"
CARDS = "docs/release-cards"
RAW = "https://raw.githubusercontent.com/RixyPow/nz-chrome/main/"
CAPTION = 1024
DONATE_URL = "https://t.me/tribute/app?startapp=g6vq"


def inline(text: str) -> str:
    """Экранирует HTML и переводит **жирный** и `код` в теги Telegram."""
    text = html.escape(text, quote=False)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    return text


def heading(text: str) -> str:
    return re.sub(r"^\d+(\.\d+)*\.?\s+", "", text.strip()).rstrip(":").strip()


def convert(body: str) -> list[str]:
    notes = body.split(FOOTER, 1)[0]
    groups: list[list[str]] = []

    def add(line: str, new_group: bool = False) -> None:
        if new_group or not groups:
            groups.append([])
        groups[-1].append(line)

    for raw in re.split(r"\n\s*\n", notes.replace("\r\n", "\n")):
        block = raw.strip()
        if not block or block.startswith("# ") or block.startswith("[!["):
            continue
        if block.startswith("### "):
            add(f"<i>{inline(heading(block[4:]))}</i>")
            continue
        if block.startswith("## "):
            add(f"<b>{inline(heading(block[3:]))}</b>", new_group=True)
            continue
        lead = re.match(r"\*\*(.+?)\*\*", block)
        if lead:
            add("• " + inline(lead.group(1).strip().rstrip(".")))

    return ["\n".join(group) for group in groups]


def compose(body: str, tag: str, url: str) -> str:
    version = tag.lstrip("v")
    head = f"<b>NZ Chrome {html.escape(version)}</b>"
    tail = [f'<a href="{html.escape(url, quote=True)}">Полный список изменений и скачивание — на GitHub</a>']

    blocks = convert(body)
    ending = "\n\n".join(tail)

    while blocks:
        text = "\n\n".join([head, *blocks, ending])
        if len(text) <= LIMIT:
            return text
        blocks.pop()
        ending = "…полностью — на GitHub.\n\n" + "\n\n".join(tail)

    return "\n\n".join([head, ending])


def card(tag: str) -> str | None:
    path = f"{CARDS}/{tag.lstrip('v')}.png"
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    return RAW + path if os.path.isfile(os.path.join(root, path)) else None


def visible(text: str) -> int:
    return len(html.unescape(re.sub(r"<[^>]+>", "", text)))


def as_photo(text: str, picture: str | None) -> bool:
    return picture is not None and visible(text) <= CAPTION


def send(text: str, picture: str | None) -> None:
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    chat = os.environ["TELEGRAM_CHAT_ID"]

    fields = {
        "chat_id": chat,
        "parse_mode": "HTML",
        "reply_markup": json.dumps({"inline_keyboard": [[{"text": "💛 Поддержать", "url": DONATE_URL}]]}),
    }

    if as_photo(text, picture):
        method = "sendPhoto"
        fields |= {"photo": picture, "caption": text}
    else:
        method = "sendMessage"
        fields |= {
            "text": text,
            "link_preview_options": json.dumps(
                {"url": picture, "prefer_large_media": True, "show_above_text": True}
                if picture
                else {"is_disabled": True}
            ),
        }

    data = urllib.parse.urlencode(fields).encode()
    request = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data)

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            answer = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            answer = json.load(error)
        except ValueError:
            answer = {"description": f"HTTP {error.code}"}

    if not answer.get("ok"):
        sys.exit(f"Telegram отказал: {answer.get('description', 'без объяснения')}")

    print("Отправлено в", chat)


def main() -> None:
    body = os.environ.get("RELEASE_BODY", "")
    tag = os.environ.get("RELEASE_TAG", "")
    url = os.environ.get("RELEASE_URL") or f"https://github.com/RixyPow/nz-chrome/releases/tag/{tag}"

    if not body.strip() or not tag:
        sys.exit("Нет текста выпуска или тега — отправлять нечего.")

    text = compose(body, tag, url)
    picture = card(tag)

    if "--dry-run" in sys.argv:
        way = "фото с подписью" if as_photo(text, picture) else "превью над текстом" if picture else "нет"
        print(f"[картинка: {picture or 'нет'} — {way}]\n")
        print(text)
        print(f"\n[кнопка под постом: 💛 Поддержать → {DONATE_URL}]")
        print(f"[{len(text)} символов из {LIMIT}, видимых {visible(text)}, подпись — до {CAPTION}]")
        return

    send(text, picture)


if __name__ == "__main__":
    main()
