/**
 * The Chat tab: conversations with your AI agent (or anyone else), and the attach menu.
 *
 * The attach menu is the part that makes this useful while browsing: it takes what is on the
 * screen — the page's text, the selection, or a picture of the page — encrypts it, uploads it,
 * and sends it as a NIP-17 file attachment. An agent reading the inbox sees exactly the same
 * attachment the Taskify app shows.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./state";
import { capturePageText, captureScreenshot, captureSelection, dataUrlToBytes } from "../lib/pageCapture";
import { fetchInbox, readAttachment, sendChatMessage, type ChatMessage } from "../lib/chat";
import { formatTime, shortFileName, formatBytes } from "./format";

/** A file waiting to be sent, either captured from the page or picked by the user. */
type PendingAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: Uint8Array;
  /** Where it came from, shown under the name. */
  origin: string;
};

export function Chat() {
  const { identity, setToast } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peer, setPeer] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  const account = identity;

  /** Reads the inbox and groups it into conversations. */
  const loadMessages = useCallback(async () => {
    if (!account?.secretKeyHex) return;
    setLoading(true);
    try {
      const inbox = await fetchInbox(account.secretKeyHex, account.pubkey);
      setMessages(inbox);
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [account, setToast]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  // Keep the newest message in view.
  useEffect(() => {
    const node = messagesRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  /** The conversations in the inbox, newest first. */
  const conversations = useMemo(() => {
    const byPeer = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      const other = message.outgoing ? message.senderPubkey : message.senderPubkey;
      const list = byPeer.get(other) ?? [];
      list.push(message);
      byPeer.set(other, list);
    }
    return Array.from(byPeer.entries())
      .map(([pubkey, items]) => ({
        pubkey,
        last: items[items.length - 1],
        count: items.length,
      }))
      .sort((left, right) => right.last.createdAt - left.last.createdAt);
  }, [messages]);

  const thread = useMemo(
    () => (peer ? messages.filter((message) => message.senderPubkey === peer) : []),
    [messages, peer],
  );

  // ── Attaching ─────────────────────────────────────────────────────────────

  const addAttachment = useCallback(
    async (kind: "page" | "selection" | "screenshot") => {
      setMenuOpen(false);
      if (!account) return;
      setUploadProgress(0);
      try {
        if (kind === "screenshot") {
          const shot = await captureScreenshot();
          if (!shot) {
            setToast("Brave would not let the extension picture this page.");
            setUploadProgress(null);
            return;
          }
          const { bytes, mimeType } = dataUrlToBytes(shot.dataUrl);
          setAttachments((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              name: `${shortFileName(shot.title, 40)}.png`,
              mimeType,
              size: bytes.byteLength,
              data: bytes,
              origin: "Screenshot",
            },
          ]);
          setUploadProgress(null);
          return;
        }

        const capture = kind === "page" ? await capturePageText() : await captureSelection();
        if (!capture?.text) {
          setToast(
            kind === "selection"
              ? "Nothing is selected on this page. The page text was used instead."
              : "This page could not be read.",
          );
          setUploadProgress(null);
          return;
        }
        const bytes = new TextEncoder().encode(capture.text);
        setAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            name: capture.filename,
            mimeType: capture.mimeType,
            size: bytes.byteLength,
            data: bytes,
            origin: kind === "selection" ? "Selected text" : "Page text",
          },
        ]);
        setUploadProgress(null);
      } catch (err) {
        setToast(err instanceof Error ? err.message : String(err));
        setUploadProgress(null);
      }
    },
    [account, setToast],
  );

  const pickLocalFile = useCallback(() => {
    setMenuOpen(false);
    fileInputRef.current?.click();
  }, []);

  const handleFilesChosen = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    void (async () => {
      const next: PendingAttachment[] = [];
      for (const file of Array.from(files)) {
        next.push({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          data: new Uint8Array(await file.arrayBuffer()),
          origin: "File",
        });
      }
      setAttachments((current) => [...current, ...next]);
    })();
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  // ── Sending ───────────────────────────────────────────────────────────────

  const send = useCallback(async () => {
    if (!account?.secretKeyHex || !peer) return;
    const text = draft.trim();
    if (!text && !attachments.length) return;

    setBusy(true);
    setDraft("");
    try {
      for (const attachment of attachments) {
        await sendChatMessage({
          secretKeyHex: account.secretKeyHex,
          pubkey: account.pubkey,
          recipientPubkey: peer,
          text: attachment.id === attachments[0]?.id ? text : undefined,
          file: {
            data: attachment.data,
            filename: attachment.name,
            mimeType: attachment.mimeType,
          },
          onUploadProgress: setUploadProgress,
        });
      }
      if (!attachments.length) {
        await sendChatMessage({
          secretKeyHex: account.secretKeyHex,
          pubkey: account.pubkey,
          recipientPubkey: peer,
          text,
        });
      }
      setAttachments([]);
      setUploadProgress(null);
      await loadMessages();
    } catch (err) {
      setDraft((current) => current || text);
      setToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [account, peer, draft, attachments, loadMessages, setToast]);

  // ── Rendering ─────────────────────────────────────────────────────────────

  if (!account) return <div className="empty">Sign in to use chat.</div>;

  if (!conversations.length) {
    return (
      <div className="pad stack">
        <div className="empty">
          <div className="empty__title">No conversations yet</div>
          <p className="hint">
            Start a conversation with your agent by sending it a message from the Taskify app, or
            paste a public key below to open a thread.
          </p>
        </div>

        <div className="row">
          <input
            className="field"
            value={peer}
            onChange={(event) => setPeer(event.target.value.trim())}
            placeholder="npub1… or a 64-character public key"
            spellCheck={false}
          />
          <button type="button" className="btn btn--primary" disabled={!peer}>
            Open
          </button>
        </div>
        <p className="hint">
          The agent's public key is the one it publishes. The <code>taskify-cli</code> agent shows it
          when you run <code>taskify context</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat__head">
        <button type="button" className="iconbtn" onClick={() => setPeer("")} aria-label="Back to conversations">
          ←
        </button>
        <div className="chat__peer">{peer ? peer.slice(0, 16) + "…" : "Conversations"}</div>
        <button type="button" className="iconbtn" onClick={() => void loadMessages()} aria-label="Refresh">
          {loading ? <span className="spinner" /> : "↻"}
        </button>
      </div>

      {!peer ? (
        <div className="body">
          <div className="pad">
            <div className="sectionhead">Conversations</div>
            {conversations.map((conversation) => (
              <button
                key={conversation.pubkey}
                type="button"
                className="card"
                style={{ display: "block", width: "100%", textAlign: "left" }}
                onClick={() => setPeer(conversation.pubkey)}
              >
                <div className="card__title">{conversation.pubkey.slice(0, 20)}…</div>
                <div className="card__meta">
                  <span className="pill">{conversation.count} messages</span>
                  <span>{formatTime(conversation.last.createdAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="chat__messages" ref={messagesRef}>
            {thread.length === 0 ? (
              <div className="empty">
                <p className="hint">This is a new conversation. Attach a page to give your agent some context.</p>
              </div>
            ) : (
              thread.map((message) => (
                <div
                  key={message.id || message.wrapId}
                  className={`bubble${message.outgoing ? " bubble--out" : ""}`}
                >
                  {message.attachment ? (
                    <AttachmentView message={message} />
                  ) : (
                    message.content
                  )}
                  <span className="bubble__time">{formatTime(message.createdAt)}</span>
                </div>
              ))
            )}
          </div>

          <div className="composer">
            {attachments.length > 0 ? (
              <div className="composer__attachments">
                {attachments.map((attachment) => (
                  <span key={attachment.id} className="attachment">
                    <span>
                      <span className="attachment__name">{shortFileName(attachment.name)}</span>
                      <span className="hint" style={{ display: "block", margin: 0 }}>
                        {attachment.origin}
                        {attachment.size ? ` · ${formatBytes(attachment.size)}` : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="attachment__remove"
                      onClick={() => removeAttachment(attachment.id)}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="composer__row">
              <div className="composer__attach-wrap">
                <button
                  type="button"
                  className="iconbtn"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-label="Attach"
                  aria-expanded={menuOpen}
                >
                  +
                </button>
                {menuOpen ? (
                  <div className="menu" role="menu">
                    <button type="button" className="menu__item" onClick={() => void addAttachment("selection")}>
                      <span className="menu__icon">✂</span>
                      <span>
                        <span className="menu__label">Selected text</span>
                        <span className="menu__desc">What you have highlighted on this page</span>
                      </span>
                    </button>
                    <button type="button" className="menu__item" onClick={() => void addAttachment("page")}>
                      <span className="menu__icon">📄</span>
                      <span>
                        <span className="menu__label">Page text</span>
                        <span className="menu__desc">The readable text of the page you are on</span>
                      </span>
                    </button>
                    <button type="button" className="menu__item" onClick={() => void addAttachment("screenshot")}>
                      <span className="menu__icon">🖼</span>
                      <span>
                        <span className="menu__label">Screenshot</span>
                        <span className="menu__desc">A picture of the page you are on</span>
                      </span>
                    </button>
                    <div className="menu__sep" />
                    <button type="button" className="menu__item" onClick={pickLocalFile}>
                      <span className="menu__icon">📎</span>
                      <span>
                        <span className="menu__label">A file</span>
                        <span className="menu__desc">From this computer</span>
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>

              <textarea
                ref={draftRef}
                className="composer__input"
                value={draft}
                rows={1}
                placeholder="Message"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />

              <button
                type="button"
                className="composer__send"
                disabled={busy || (!draft.trim() && !attachments.length)}
                onClick={() => void send()}
                aria-label="Send"
              >
                {busy || uploadProgress !== null ? <span className="spinner" /> : "↑"}
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(event) => {
                handleFilesChosen(event.target.files);
                event.target.value = "";
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** An attachment in a message: the file's name, and its text if it is a text file. */
function AttachmentView({ message }: { message: ChatMessage }) {
  const attachment = message.attachment!;
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!attachment.mimeType.startsWith("text/") && attachment.mimeType !== "application/json") return;
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await readAttachment(attachment);
        if (cancelled) return;
        setText(new TextDecoder().decode(bytes).slice(0, 4000));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment]);

  return (
    <div>
      <div className="bubble__file">
        <span>📄</span>
        <span>
          <span className="bubble__filename">{shortFileName(attachment.filename, 40)}</span>
          <span className="hint" style={{ display: "block", margin: 0 }}>
            {attachment.size ? formatBytes(attachment.size) : ""}
          </span>
        </span>
      </div>
      {failed ? <div className="hint">This attachment could not be read.</div> : null}
      {text ? (
        <details style={{ marginTop: 6 }}>
          <summary className="hint" style={{ cursor: "pointer" }}>
            Preview
          </summary>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 11.5,
              margin: "4px 0 0",
              maxHeight: 220,
              overflow: "auto",
              opacity: 0.85,
            }}
          >
            {text}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
