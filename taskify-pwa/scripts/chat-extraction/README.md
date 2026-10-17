# Chat extraction tools (temporary)

Throwaway scripts for moving Chat out of `src/components/CashuWalletModal.tsx`. Delete this folder
once Chat is its own page. See "Chat independence" in
`docs/audits/improvement-review-2026-10-15.md` for the plan and status.

- `analyze.py`: splits the modal component body into top-level statements and records what each
  defines and uses (writes `stmts.json` to a scratch folder; edit the `SP` path at the top).
- `closure2.py`: the dependency closure of what the chat UI needs, without passing through wallet
  hooks (listed in `wallet_hooks.json`). Prints chat
  statements that still touch wallet names, and wallet names the chat UI still needs.
- `split.py`: moves named declarations (plus what they call) from one module to another and makes
  the source re-export them. Used for `chat/chatHelpers.tsx` and `chat/chatUi.tsx`.
- `fiximports.py`: rewrites relative imports after moving files (argument: JSON map of
  old path to new path, without extensions, relative to the package root).
- `chat_block_clean.tsx.txt`: the chat JSX from the modal (`{isChatPage && (...)}`) with the
  payment card replaced by `<ChatTokenBubble>` and the pay buttons removed. The starting point
  for `ChatPage`.
