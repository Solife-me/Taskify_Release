// Mammoth doesn't ship its own types and there's no @types/mammoth.
// We use `mammoth/mammoth.browser` (the prebuilt browser entry) and only
// rely on `convertToHtml`. Keep the surface minimal.

declare module "mammoth/mammoth.browser" {
  type ConvertInput = {
    arrayBuffer: ArrayBuffer;
  };

  type ConvertOptions = {
    styleMap?: string | string[];
    includeDefaultStyleMap?: boolean;
    convertImage?: unknown;
    ignoreEmptyParagraphs?: boolean;
  };

  type ConvertMessage = {
    type: string;
    message: string;
  };

  type ConvertResult = {
    value: string;
    messages: ConvertMessage[];
  };

  export function convertToHtml(input: ConvertInput, options?: ConvertOptions): Promise<ConvertResult>;
  export function extractRawText(input: ConvertInput, options?: ConvertOptions): Promise<ConvertResult>;
  export const images: unknown;
}
