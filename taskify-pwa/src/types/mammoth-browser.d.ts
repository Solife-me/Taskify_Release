declare module "mammoth/mammoth.browser" {
  export type ConvertToHtmlOptions = {
    includeDefaultStyleMap?: boolean;
    styleMap?: string[];
  };

  export type ConvertResult = {
    value: string;
    messages?: unknown[];
  };

  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: ConvertToHtmlOptions,
  ): Promise<ConvertResult>;
}
