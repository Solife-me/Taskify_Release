import React from "react";

export function ImageViewer({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="h-full overflow-auto rounded-[28px] bg-[#0f1012] [touch-action:auto]">
      <div className="flex min-h-full min-w-full items-start justify-center p-4">
        <img
          src={src}
          alt={alt}
          className="block h-auto max-w-full rounded-[22px] shadow-2xl"
        />
      </div>
    </div>
  );
}
