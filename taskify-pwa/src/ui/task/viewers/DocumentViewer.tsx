import React from "react";

interface DocumentContent {
  type: "html" | "text";
  data: string;
}

export function DocumentViewer({ content }: { content: DocumentContent }) {
  return (
    <div className="h-full overflow-auto rounded-[28px] bg-[#15161a] [touch-action:auto]">
      <div className="min-h-full p-4">
        <div className="mx-auto w-full max-w-4xl overflow-x-auto rounded-[28px] bg-white px-4 py-6 text-[#111827] shadow-2xl sm:px-6 sm:py-8">
          {content.type === "html" ? (
            <div className="doc-modal__markup doc-modal__markup--rich doc-modal__markup--mobile-safe" dangerouslySetInnerHTML={{ __html: content.data }} />
          ) : (
            <pre className="doc-modal__text whitespace-pre-wrap break-words text-[15px] leading-7 text-[#111827]">{content.data}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
