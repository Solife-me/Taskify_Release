# Encrypted attachment filename privacy

Taskify treats an attachment's original name, extension, and MIME type as private metadata. The
file host, relay observers, and anyone holding only the public ciphertext URL must not learn them.

## Upload contract

For every encrypted task, event, chat, share-extension, Watch, and CLI attachment:

1. Encrypt the plaintext first.
2. Compute SHA-256 over the exact ciphertext bytes being uploaded.
3. Upload under `<lowercase-ciphertext-sha256>.bin`.
4. Use `application/octet-stream` as the upload content type.
5. Keep the original name only inside the already-encrypted board payload or NIP-17 rumor. The
   recipient restores it after decrypting the attachment metadata.

`taskify-core` owns the shared filename rule and fixture. Native clients mirror the same rule and
consume the same fixture, so the result cannot drift between clients.

## Compatibility

Legacy attachment URLs remain readable. This rule applies to new uploads; it does not require
renaming or re-encrypting existing attachments. A remote URL without an encrypted filename is
still displayed using the decrypted task/document or NIP-17 attachment metadata.
