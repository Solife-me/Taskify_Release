/**
 * Taskify's Hermes model-menu adapter.
 *
 * Hermes has no structured UI callback on non-Telegram platforms. Its `/model` text fallback
 * carries provider previews, while a one-provider agent request can return a complete JSON
 * catalog. These parsers are deliberately strict: clients should render buttons only from values
 * that were recognized in a known Hermes response shape.
 */
export declare const HERMES_PROVIDER_PAGE_SIZE = 10;
export declare const HERMES_MODEL_PAGE_SIZE = 8;
export type HermesModelProvider = {
    name: string;
    slug: string;
    previewModels: string[];
    totalModels: number;
    isCurrent: boolean;
};
export type HermesModelListing = {
    currentModel: string | null;
    currentProviderSlug: string | null;
    providers: HermesModelProvider[];
};
export type HermesProviderCatalog = {
    providerName: string | null;
    providerSlug: string;
    models: string[];
};
export type HermesModelSwitchConfirmation = {
    modelId: string;
    providerName: string | null;
};
export declare function isValidHermesProviderSlug(value: unknown): value is string;
export declare function isValidHermesModelId(value: unknown): value is string;
export declare function parseHermesModelListing(text: string): HermesModelListing | null;
export declare function parseHermesProviderCatalog(text: string, expectedProviderSlug?: string): HermesProviderCatalog | null;
export declare function parseHermesModelSwitchConfirmation(text: string): HermesModelSwitchConfirmation | null;
/** Encrypted rumor tags used to hide Taskify bot-UI commands and correlate their replies. */
export declare const TASKIFY_BOT_UI_TAG = "taskify-bot-ui";
export declare const TASKIFY_BOT_UI_VERSION = "v1";
export type TaskifyBotUiAction = {
    kind: "catalog-request";
    menuId: string;
    providerSlug: string;
} | {
    kind: "model-select";
    menuId: string;
    providerSlug: string;
    modelId: string;
};
export declare function buildTaskifyBotUiActionTag(action: TaskifyBotUiAction): string[];
export declare function parseTaskifyBotUiAction(tags: unknown[] | null | undefined): TaskifyBotUiAction | null;
