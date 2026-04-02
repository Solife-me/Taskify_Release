import React from "react";

export function VideoViewer({ src, poster }: { src: string; poster?: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-[28px] bg-black p-2 shadow-2xl">
      <video
        controls
        autoPlay
        playsInline
        preload="metadata"
        poster={poster}
        src={src}
        className="max-h-full w-full rounded-[22px] bg-black"
      />
    </div>
  );
}
