import React from "react";

export function EcashGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.5"
    >
      <circle cx="8.5" cy="10" r="4.25" />
      <circle cx="12.5" cy="10" r="4.25" opacity="0.65" />
    </svg>
  );
}

export default EcashGlyph;
