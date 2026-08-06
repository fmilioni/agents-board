#!/usr/bin/env python3
"""Upload an image to a project and print the markdown that references it.

    python3 scripts/attach-image.py <file> <projectId> [alt text]

The bytes go straight from disk to the API over HTTP — they never pass through
an AI context. What comes back is the attachment id and a
``![alt](/attachments/att_X)`` to paste into a card, doc, comment or inbox body;
saving that body is what links the attachment (an upload nobody references is
swept after the grace window).

Standard library only; a Node twin lives at scripts/attach-image.mjs for
machines without Python. Keep the two in sync.

Config: AB_API_URL (default http://127.0.0.1:4400), AB_UPLOAD_TOKEN (only with
auth on — mint it with the MCP's issue_upload_token).
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

# Windows' cp1252 console can't encode the ✓/✗ glyphs; force UTF-8 so the final
# print doesn't crash after the POST already succeeded.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

API_URL = os.environ.get("AB_API_URL", "http://127.0.0.1:4400").rstrip("/")
UPLOAD_TOKEN = os.environ.get("AB_UPLOAD_TOKEN")

# Mirrors ATTACHMENT_MIME_TYPES in @agents-board/shared.
EXT_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}
# The API's own ceiling; failing here says so instead of spending the upload.
MAX_BYTES = 10 * 1024 * 1024


def fail(msg):
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def human_bytes(n):
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def multipart_body(path, mime):
    boundary = uuid.uuid4().hex
    # A quote or CRLF in the name would end the header early and let the rest of
    # the filename be read as another part; the Node twin's FormData escapes it.
    filename = path.name.translate({ord(c): None for c in '"\r\n'})
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return boundary, head + path.read_bytes() + tail


def main():
    args = sys.argv[1:]
    if len(args) < 2 or not args[0] or not args[1]:
        fail("usage: attach-image <file> <projectId> [alt text]")
    file_arg, project_id, *alt_parts = args

    path = Path(file_arg)
    if not path.exists():
        fail(f"no such file: {file_arg}")
    if not path.is_file():
        fail(f"{file_arg} is not a file")
    size = path.stat().st_size

    ext = path.suffix.lstrip(".").lower()
    mime = EXT_MIME.get(ext)
    if not mime:
        allowed = ", ".join(EXT_MIME)
        fail(f'unsupported image type "{ext or path.name}". Allowed: {allowed}.')
    if size > MAX_BYTES:
        fail(f"{human_bytes(size)} exceeds the {human_bytes(MAX_BYTES)} upload limit")

    boundary, body = multipart_body(path, mime)
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    if UPLOAD_TOKEN:
        headers["X-AB-Upload-Token"] = UPLOAD_TOKEN

    query = urllib.parse.urlencode({"projectId": project_id})
    req = urllib.request.Request(
        f"{API_URL}/attachments?{query}", data=body, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        if err.code == 401:
            fail(
                "API responded 401: auth is on and no valid upload token was sent. "
                "Mint one with issue_upload_token(<projectId>) and re-run with "
                "AB_UPLOAD_TOKEN=<token>."
            )
        fail(f"API responded {err.code}: {err.read().decode('utf-8', 'replace')}")
    except urllib.error.URLError as err:
        fail(f"could not reach the API at {API_URL} ({err.reason}). Is it running?")

    alt = " ".join(alt_parts).strip()
    if not alt:
        print(
            "! no alt text given — search finds an image by its description, so pass one",
            file=sys.stderr,
        )
    print(
        f"✓ {payload['id']} — {payload['width']}×{payload['height']}, "
        f"{human_bytes(size)} read from disk"
    )
    print(f"![{alt}]({payload['url']})")


try:
    main()
except OSError as err:
    fail(str(err))
