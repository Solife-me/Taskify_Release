import { QrCodeCard as ChatQrCodeCard } from "../../chat/chatUi";
import React from "react";
import { createNut16Animation } from "../../wallet/nut16";


// Chat UI pieces now live in chat/chatUi; the wallet re-exports them.
export * from "../../chat/chatUi";

/** The chat QR card with NUT-16 animation for Cashu tokens, which only the wallet shows. */
export function QrCodeCard(props: React.ComponentProps<typeof ChatQrCodeCard>) {
  return <ChatQrCodeCard createAnimation={createNut16Animation} {...props} />;
}

export { contactInitials as avatarInitials } from "taskify-core";

export function formatLightningAddressDisplay(address: string, baseMaxLength = 32): string {
  const ellipsis = "…";
  if (address.length <= baseMaxLength) return address;
  const atIndex = address.indexOf("@");
  if (atIndex <= 0) {
    return `${address.slice(0, baseMaxLength - 1)}${ellipsis}`;
  }

  const localPart = address.slice(0, atIndex);
  const domainPartWithAt = address.slice(atIndex);
  const dynamicMaxLength = Math.max(baseMaxLength, domainPartWithAt.length + 6);
  if (address.length <= dynamicMaxLength) return address;

  const maxLocalLength = Math.max(3, dynamicMaxLength - domainPartWithAt.length - ellipsis.length);
  return `${localPart.slice(0, maxLocalLength)}${ellipsis}${domainPartWithAt}`;
}

export { capitalizeWords, formatMintDisplayName } from "../../wallet/mintDisplayName";


export function trimMintUrlScheme(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

export function LockIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="5" y="9" width="10" height="7" rx="2" />
      <path d="M7.5 9V7a2.5 2.5 0 0 1 5 0v2" />
      <circle cx="10" cy="12.5" r="1" />
    </svg>
  );
}

export function ChevronDownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M5.5 8.5 10 13l4.5-4.5" />
    </svg>
  );
}

export function LightningGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="11 2 4 11 9 11 7 18 14 9 9 9 11 2" />
    </svg>
  );
}

export function WalletGlyphIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="8" y1="16" x2="16" y2="16" />
      <line x1="12" y1="2.75" x2="12" y2="5.25" />
      <line x1="12" y1="18.75" x2="12" y2="21.25" />
    </svg>
  );
}

