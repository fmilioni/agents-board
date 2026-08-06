#!/usr/bin/env python3
"""Capture a commit's diff and attach it to its card via the REST API.

    python3 scripts/attach-commit.py <sha> [AB-N]

The card key is parsed from the commit message (``feat(...): … (AB-12)``) unless
passed explicitly. The diff goes straight from ``git`` to the API over HTTP — it
never passes through an AI context (no MCP, no tokens spent reading it).

Standard library only; a Node twin lives at scripts/attach-commit.mjs for
machines without Python. Keep the two in sync.

Config: AB_API_URL (default http://127.0.0.1:4400).
"""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

# Windows' cp1252 console can't encode the ✓/✗/→ glyphs; force UTF-8 so the
# final print doesn't crash after the POST already succeeded.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

API_URL = os.environ.get("AB_API_URL", "http://127.0.0.1:4400").rstrip("/")

# Card-scoped token minted by the MCP (issue_commit_token); only needed when the
# API has auth on. Absent in sem-auth mode — then no extra header is sent.
COMMIT_TOKEN = os.environ.get("AB_COMMIT_TOKEN")


def with_token(headers):
    if COMMIT_TOKEN:
        return {**headers, "X-AB-Commit-Token": COMMIT_TOKEN}
    return headers

# Files whose body is noise: store the header + a note instead of the patch.
LOCKFILES = {
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "npm-shrinkwrap.json",
    "bun.lockb",
}
# Per-file line cap; beyond it the patch is truncated with a note.
MAX_LINES_PER_FILE = 1000

# Raster images are captured as before/after attachments and rendered in the web
# diff (AB-392); other binaries keep the plain note. Mirrors the attachment
# allow-list in @agents-board/shared.
IMAGE_EXT_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}
# Skip the upload above this and keep the binary note; aligned with the API's
# 10 MB upload ceiling so we never ship a blob the server would reject.
MAX_IMAGE_BYTES = 10 * 1024 * 1024

# `AB-12`, `ABC-7` — an uppercase prefix, a dash, digits.
KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]*-\d+)\b")


def fail(msg):
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def git(args):
    try:
        return subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except subprocess.CalledProcessError as err:
        first = (err.stderr or "").split("\n", 1)[0]
        fail(f"git {' '.join(args)} failed: {first}")


def image_mime(path):
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return IMAGE_EXT_MIME.get(ext)


# The sentinel that replaces `Binary files … differ` so the web can render the
# image. Must match buildDiffImageSentinel / DIFF_IMAGE_SENTINEL_PREFIX in
# @agents-board/shared (a side is omitted when absent).
def image_sentinel(old_id, new_id):
    line = "# image"
    if old_id:
        line += f" old={old_id}"
    if new_id:
        line += f" new={new_id}"
    return line


# Binary-safe git read (bytes, no decode); None when the path is absent at that
# ref (an added file has no parent blob; a deleted file has none at the commit).
def git_blob(args):
    try:
        return subprocess.run(["git", *args], capture_output=True, check=True).stdout
    except subprocess.CalledProcessError:
        return None


# Upload one image side to the AB-393 endpoint; returns its att id, or None when
# the blob is missing/over the cap, OR the upload errored — a per-image failure
# degrades to the plain binary note for that section, never discarding the whole
# diff (the diff POST stays the hard gate on a down API).
def upload_image(buf, path, key):
    if not buf or len(buf) > MAX_IMAGE_BYTES:
        return None
    mime = image_mime(path)
    if not mime:
        return None
    boundary = "----co-image-boundary"
    filename = path.rsplit("/", 1)[-1] or "image"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode("utf-8") + buf + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        f"{API_URL}/cards/{key}/commit-images",
        data=body,
        headers=with_token(
            {"Content-Type": f"multipart/form-data; boundary={boundary}"}
        ),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read()).get("id")
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None


def parse_key(message):
    """Prefer the last key on the subject line, else the first anywhere."""
    subject = message.split("\n", 1)[0]
    on_subject = KEY_RE.findall(subject)
    if on_subject:
        return on_subject[-1]
    anywhere = KEY_RE.findall(message)
    return anywhere[0] if anywhere else None


def is_ignored(path):
    base = path.rsplit("/", 1)[-1]
    if base in LOCKFILES:
        return True
    if re.search(r"\.min\.[^.]+$", base):
        return True
    if path.startswith("dist/") or "/dist/" in path:
        return True
    return False


def section_path(lines):
    for l in lines:
        if l.startswith("+++ b/"):
            return l[6:]
    for l in lines:
        if l.startswith("--- a/"):
            return l[6:]
    m = re.match(r"^diff --git a/(.+) b/(.+)$", lines[0])
    return m.group(2) if m else ""


# Capture an image binary section: upload its old/new blobs and replace the
# binary marker (and any GIT binary patch body) with the image sentinel. Falls
# back to the original lines (plain note) when neither side could be uploaded.
def capture_image_section(lines, path, key, sha):
    old_id = upload_image(git_blob(["show", f"{sha}^:{path}"]), path, key)
    new_id = upload_image(git_blob(["show", f"{sha}:{path}"]), path, key)
    if not old_id and not new_id:
        return "\n".join(lines)
    bin_idx = next(
        (
            i
            for i, l in enumerate(lines)
            if re.match(r"^Binary files .* differ$", l)
            or l.startswith("GIT binary patch")
        ),
        -1,
    )
    head = lines[:bin_idx] if bin_idx >= 0 else lines
    return "\n".join([*head, image_sentinel(old_id, new_id)])


def prune_diff(patch, key, sha):
    """Split the unified patch per file and apply the safeguards."""
    if not patch.strip():
        return ""
    sections = []
    current = None
    for line in patch.split("\n"):
        if line.startswith("diff --git "):
            if current:
                sections.append(current)
            current = [line]
        elif current is not None:
            current.append(line)
    if current:
        sections.append(current)

    out = []
    for lines in sections:
        path = section_path(lines)
        is_binary = any(
            re.match(r"^Binary files .* differ$", l) or l.startswith("GIT binary patch")
            for l in lines
        )
        if is_binary:
            if not is_ignored(path) and image_mime(path):
                out.append(capture_image_section(lines, path, key, sha))
            else:
                out.append("\n".join(lines))
        elif is_ignored(path):
            out.append(f"{lines[0]}\n# diff omitted (lockfile/generated)")
        elif len(lines) > MAX_LINES_PER_FILE:
            omitted = len(lines) - MAX_LINES_PER_FILE
            out.append(
                "\n".join(lines[:MAX_LINES_PER_FILE])
                + f"\n# ... (truncated: {omitted} lines omitted)"
            )
        else:
            out.append("\n".join(lines))
    return "\n".join(out)


def human_bytes(n):
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def main():
    args = sys.argv[1:]
    if not args:
        fail("usage: attach-commit <sha> [AB-N]")
    sha_arg = args[0]
    key_arg = args[1] if len(args) > 1 else None

    # Validate the sha and normalise it to the full hash.
    sha = git(["rev-parse", "--verify", f"{sha_arg}^{{commit}}"]).strip()

    message = git(["show", "-s", "--format=%B", sha]).rstrip("\n")
    committed_at = git(["show", "-s", "--format=%cI", sha]).strip()
    author_name = git(["show", "-s", "--format=%an", sha]).strip()

    key = key_arg or parse_key(message)
    if not key:
        fail(
            f"no card key found in the message of {sha[:8]}; "
            f"pass one explicitly: attach-commit {sha_arg} AB-N"
        )

    stat = git(["show", sha, "--stat", "--format="]).strip("\n")
    raw_diff = git(["show", sha, "--format=", "--patch"])
    diff = prune_diff(raw_diff, key, sha)

    file_count = len(re.findall(r"^diff --git ", raw_diff, re.MULTILINE))

    payload = json.dumps(
        {
            "sha": sha,
            "message": message,
            "stat": stat,
            "diff": diff,
            "committedAt": committed_at,
            "authorName": author_name,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        f"{API_URL}/cards/{key}/commits",
        data=payload,
        headers=with_token({"Content-Type": "application/json"}),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as res:
            res.read()
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        fail(f"API responded {err.code}: {body}")
    except urllib.error.URLError as err:
        fail(f"could not reach the API at {API_URL} ({err.reason}). Is it running?")

    diff_bytes = len(diff.encode("utf-8"))
    print(f"✓ {key} {sha[:8]} — {file_count} file(s), {human_bytes(diff_bytes)} diff → attached")


if __name__ == "__main__":
    main()
