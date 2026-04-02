import React, { useEffect, useState } from "react";
import { ensurePdfjs } from "../../../lib/documents";

type RenderedPage = {
  src: string;
};

export function PdfViewer({ dataUrl }: { dataUrl: string }) {
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPages([]);

    (async () => {
      try {
        const pdfjs = await ensurePdfjs();
        const bytes = await fetch(dataUrl).then((r) => r.arrayBuffer());
        const pdf = await pdfjs.getDocument({ data: bytes }).promise;
        const rendered: RenderedPage[] = [];

        for (let i = 1; i <= pdf.numPages; i += 1) {
          if (cancelled) return;
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1.35 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          rendered.push({ src: canvas.toDataURL("image/png") });
        }

        if (!cancelled) {
          setPages(rendered);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || "Failed to render PDF");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataUrl]);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-white/70">Rendering PDF…</div>;
  }

  if (error || !pages.length) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="rounded-[28px] bg-[#1b1c20] px-6 py-8 text-center text-white/70 shadow-2xl">
          {error || "Failed to render PDF. Use Download to open the original file."}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto rounded-[28px] bg-[#15161a] [touch-action:auto]">
      <div className="flex min-h-full items-start justify-center p-4">
        <div className="flex w-full max-w-5xl flex-col gap-4">
          {pages.map((page, index) => (
            <img
              key={index}
              src={page.src}
              alt={`PDF page ${index + 1}`}
              className="block w-full rounded-[22px] bg-white shadow-2xl"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
