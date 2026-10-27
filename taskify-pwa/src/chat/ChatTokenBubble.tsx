/**
 * A Cashu ecash token someone sent in a message. Chat has no wallet, so it only shows the token
 * and lets the user copy it into a wallet of their choice.
 */
export function ChatTokenBubble({ token, onCopy }: { token: string; onCopy: (value: string) => void }) {
  const value = token.trim();
  return (
    <div className="chat-token-bubble">
      <div className="chat-token-bubble__label">Cashu token</div>
      <div className="chat-token-bubble__value" title={value}>
        {value.length > 48 ? `${value.slice(0, 32)}…${value.slice(-12)}` : value}
      </div>
      <button type="button" className="ghost-button button-sm pressable chat-token-bubble__copy" onClick={() => onCopy(value)}>
        Copy token
      </button>
      <div className="chat-token-bubble__hint">Paste it into a Cashu wallet to receive it.</div>
    </div>
  );
}
