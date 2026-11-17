"""audiobook_request — let allowlisted friends ask for an ebook to be narrated.

Design constraints this file exists to satisfy:

* A `friend` on this platform gets chat + web search only (``policy.FRIEND_ALLOWED``).
  Narration needs audiblez, ffmpeg and disk, so friends must NOT receive `terminal`
  or any escalation. They get exactly this one tool, which validates a file and
  drops it in a queue; a separate cron worker does the rendering.
* The tool returns immediately. A book takes 5-60 minutes to narrate, far longer
  than a chat turn, so nothing here blocks.
* Abuse is bounded before touching the host or filling its disk: file
  type, size, readable text layer, estimated length, per-sender queue depth and a
  per-sender daily cap all get checked here.

Queue layout under ``~/.hermes/audiobook_requests/``::

    pending/<id>/request.json + the source file
    working/<id>/...
    done/<id>/...
    failed/<id>/reason.txt

The worker (``~/.hermes/scripts/friend_audiobook_worker.py``) consumes `pending`.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import uuid
import zipfile

HOME = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
QUEUE_ROOT = os.path.join(HOME, "audiobook_requests")
PENDING = os.path.join(QUEUE_ROOT, "pending")
WORKING = os.path.join(QUEUE_ROOT, "working")
DONE = os.path.join(QUEUE_ROOT, "done")
FAILED = os.path.join(QUEUE_ROOT, "failed")

KINDS = (".epub", ".pdf")
MAX_SOURCE_BYTES = 80 * 1024 * 1024      # a 400-page epub is ~1 MB; 80 MB is generous
MAX_WORDS = 260_000                     # ~2,400 audio-minutes. Beyond this the render
                                        # monopolises the VM for hours and its WAVs
                                        # (~175 MB per audio-hour) can fill the disk.
MAX_PENDING_PER_SENDER = 1
MAX_PER_DAY_PER_SENDER = 2
MAX_GLOBAL_PENDING = 4

AUD = os.path.join(HOME, "hermes-agent/venv/bin/audiblez")


def _err(msg: str) -> str:
    return json.dumps({"success": False, "error": msg})


def _ok(msg: str, **extra) -> str:
    return json.dumps({"success": True, "message": msg, **extra})


def _ensure_dirs() -> None:
    for d in (PENDING, WORKING, DONE, FAILED):
        os.makedirs(d, exist_ok=True)


def _word_count(path: str) -> int:
    """Rough word count — enough to refuse a 60-hour book before rendering it."""
    try:
        if path.lower().endswith(".epub"):
            text = ""
            with zipfile.ZipFile(path) as z:
                for n in z.namelist():
                    if n.lower().endswith((".xhtml", ".html", ".htm")):
                        text += re.sub(r"<[^>]+>", " ", z.read(n).decode("utf-8", "ignore"))
            return len(re.findall(r"[A-Za-z']+", text))
        out = subprocess.run(["pdftotext", path, "-"], capture_output=True,
                             text=True, timeout=120).stdout
        return len(re.findall(r"[A-Za-z']+", out))
    except Exception:
        return 0


def _has_text_layer(path: str) -> bool:
    """A scanned PDF has no text; audiblez would produce an empty book."""
    return _word_count(path) > 500


def _counts_for(sender: str) -> tuple[int, int]:
    """(pending for this sender, accepted in the last 24h)."""
    pend = 0
    for rid in os.listdir(PENDING) if os.path.isdir(PENDING) else []:
        try:
            meta = json.load(open(os.path.join(PENDING, rid, "request.json")))
            if meta.get("requester") == sender:
                pend += 1
        except Exception:
            continue
    day_ago = time.time() - 86400
    recent = 0
    for base in (DONE, WORKING):
        if not os.path.isdir(base):
            continue
        for rid in os.listdir(base):
            try:
                meta = json.load(open(os.path.join(base, rid, "request.json")))
                if meta.get("requester") == sender and meta.get("accepted_at", 0) > day_ago:
                    recent += 1
            except Exception:
                continue
    return pend, recent


def audiobook_request(file_path: str, title: str = "", task_id: str = "", **kwargs) -> str:
    """Validate an attached ebook and queue it for narration."""
    _ensure_dirs()

    # Who is asking? The platform sets the acting sender for the dispatch.
    sender = ""
    role = ""
    try:
        from . import policy  # package-relative: this module ships inside the plugin
        sender = policy.get_actor() or ""
        role = policy.restricted_role(sender) or "owner"
    except Exception:
        try:
            import policy as policy  # type: ignore  # loaded as a top-level module
            sender = policy.get_actor() or ""
            role = policy.restricted_role(sender) or "owner"
        except Exception:
            role = "owner"

    if not file_path or not os.path.exists(file_path):
        return _err("No attachment found. Send the book as a file attachment "
                    "(.epub or text .pdf), with a short note if you like.")

    size = os.path.getsize(file_path)
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in KINDS:
        return _err(f"Only .epub or .pdf can be narrated, not '{ext or 'unknown type'}'.")
    if size > MAX_SOURCE_BYTES:
        return _err(f"That file is {size // (1024*1024)} MB; the limit is "
                    f"{MAX_SOURCE_BYTES // (1024*1024)} MB.")
    if not _has_text_layer(file_path):
        return _err("That PDF has no readable text layer (it looks scanned), so there "
                    "is nothing to narrate. A text-based PDF or an .epub will work.")

    words = _word_count(file_path)
    if words > MAX_WORDS:
        return _err(f"That book is about {words:,} words (~{words/179/60:.0f} hours of "
                    f"audio), over the {MAX_WORDS:,}-word limit for a request.")

    if role == "friend":
        pend, recent = _counts_for(sender)
        if pend >= MAX_PENDING_PER_SENDER:
            return _err("You already have a book in the queue — I'll send that one "
                        "before starting another.")
        if recent >= MAX_PER_DAY_PER_SENDER:
            return _err(f"That's {recent} books today, which is the daily limit. "
                        "Try again tomorrow.")

    try:
        waiting = len(os.listdir(PENDING))
    except Exception:
        waiting = 0
    if waiting >= MAX_GLOBAL_PENDING:
        return _err("The narration queue is full right now. Try again a bit later.")

    rid = uuid.uuid4().hex[:10]
    job_dir = os.path.join(PENDING, rid)
    os.makedirs(job_dir, exist_ok=True)
    base = os.path.basename(file_path)
    keep = os.path.join(job_dir, base)
    try:
        shutil.copy2(file_path, keep)
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        return _err(f"Could not take the file: {e}")

    meta = {
        "id": rid,
        "requester": sender,
        "role": role,
        # The worker replies to this chat id (the sender's pubkey).
        "reply_chat": sender,
        "source": base,
        "title": (title or "").strip(),
        "size": size,
        "words": words,
        "est_minutes": round(words / 179, 1),
        "accepted_at": time.time(),
        "queued_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    with open(os.path.join(job_dir, "request.json"), "w") as fh:
        json.dump(meta, fh, indent=2)

    mins = meta["est_minutes"]
    span = f"{mins/60:.1f} hours" if mins >= 60 else f"{mins:.0f} minutes"
    return _ok(
        f"Queued: {base} ({words:,} words, roughly {span} of audio). "
        f"I'll send the finished audiobook here as a file attachment when it's done.",
        request_id=rid, est_minutes=mins)


AUDIOBOOK_REQUEST_SCHEMA = {
    "name": "audiobook_request",
    "description": (
        "Queue an attached ebook to be narrated into an audiobook. Use this when the "
        "user sends a .epub or text .pdf and asks for an audiobook, or sends a book "
        "file with no other instruction. Pass the local path of the attachment you "
        "were given. Returns immediately with a queue confirmation — the finished "
        "m4b arrives later as a file attachment, so do NOT wait for it in the turn "
        "and do not try to narrate anything yourself."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Local path of the attached .epub/.pdf (the media path "
                               "supplied with the incoming message).",
            },
            "title": {
                "type": "string",
                "description": "Optional title override; derived from the file name "
                               "when omitted.",
            },
        },
        "required": ["file_path"],
    },
}


def register_audiobook_tool(ctx) -> None:
    """Called from the platform plugin's register(ctx)."""
    ctx.register_tool(
        name="audiobook_request",
        toolset="file",
        schema=AUDIOBOOK_REQUEST_SCHEMA,
        handler=lambda args, **kw: audiobook_request(
            file_path=args.get("file_path", ""),
            title=args.get("title", ""),
            task_id=kw.get("task_id", ""),
        ),
        description="Queue an attached ebook for narration into an m4b",
        emoji="🎧",
    )
