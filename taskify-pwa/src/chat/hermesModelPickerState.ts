import {
  HERMES_MODEL_PAGE_SIZE,
  HERMES_PROVIDER_PAGE_SIZE,
  isValidHermesModelId,
  isValidHermesProviderSlug,
  parseHermesModelListing,
  parseHermesModelSwitchConfirmation,
  parseHermesProviderCatalog,
  parseHermesSessionListing,
  type HermesModelListing,
  type HermesProviderCatalog,
  type HermesSessionListing,
  type TaskifyBotUiAction,
} from "taskify-core";
import type { WalletDmMessage } from "./hooks/useDmState";

export { HERMES_MODEL_PAGE_SIZE, HERMES_PROVIDER_PAGE_SIZE };

export type HermesSelectedModel = {
  modelId: string;
  providerSlug: string;
  providerName: string | null;
};

export type HermesMenuProjection = {
  listingEventId: string;
  menuId: string;
  listing: HermesModelListing;
  catalogs: Map<string, HermesProviderCatalog>;
  selectedModel: HermesSelectedModel | null;
  pendingAction: TaskifyBotUiAction | null;
  failure: {
    action: TaskifyBotUiAction;
    responseEventId: string;
    responseContent: string;
  } | null;
};

export type HermesBotUiProjection = {
  hiddenEventIds: Set<string>;
  menusByListingEventId: Map<string, HermesMenuProjection>;
  sessionsByListingEventId: Map<string, HermesSessionListing>;
};

const EMPTY_PROJECTION: HermesBotUiProjection = {
  hiddenEventIds: new Set(),
  menusByListingEventId: new Map(),
  sessionsByListingEventId: new Map(),
};

function stableMenuId(message: WalletDmMessage): string | null {
  const candidate = (message.rumorEventId || message.eventId || "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : null;
}

function isPlainTextMessage(message: WalletDmMessage): boolean {
  return !message.attachment || message.attachment.type === "text";
}

/**
 * Reconstruct Hermes model menus and named-session listings from the encrypted message history.
 *
 * Taskify-generated commands carry an encrypted `taskify-bot-ui` tag. The next incoming bot
 * message is accepted as the response only when it parses as the exact shape requested by that
 * action. Matching commands and responses are hidden; malformed responses stay visible so users
 * retain a readable fallback.
 */
export function projectHermesBotUi(messages: WalletDmMessage[], enabled = true): HermesBotUiProjection {
  if (!enabled) return EMPTY_PROJECTION;

  const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  const hiddenEventIds = new Set<string>();
  const menusByListingEventId = new Map<string, HermesMenuProjection>();
  const sessionsByListingEventId = new Map<string, HermesSessionListing>();
  const menusByMenuId = new Map<string, HermesMenuProjection>();

  for (const message of ordered) {
    if (!message.isIncoming || message.groupId || !isPlainTextMessage(message)) continue;
    const sessionListing = parseHermesSessionListing(message.content);
    if (sessionListing) {
      sessionsByListingEventId.set(message.eventId, sessionListing);
      continue;
    }
    const listing = parseHermesModelListing(message.content);
    if (!listing) continue;
    const menuId = stableMenuId(message);
    if (!menuId) continue;
    const projection: HermesMenuProjection = {
      listingEventId: message.eventId,
      menuId,
      listing,
      catalogs: new Map(),
      selectedModel: null,
      pendingAction: null,
      failure: null,
    };
    menusByListingEventId.set(message.eventId, projection);
    menusByMenuId.set(menuId, projection);
  }

  if (!menusByMenuId.size) return { hiddenEventIds, menusByListingEventId, sessionsByListingEventId };

  let pending: { action: TaskifyBotUiAction; responseEventId: string } | null = null;
  for (const message of ordered) {
    if (!message.isIncoming && message.botUiAction) {
      const action = message.botUiAction;
      hiddenEventIds.add(message.eventId);
      const menu = menusByMenuId.get(action.menuId);
      if (!menu) continue;
      menu.pendingAction = action;
      menu.failure = null;
      pending = { action, responseEventId: message.eventId };
      continue;
    }

    if (!message.isIncoming || !pending) continue;
    const menu = menusByMenuId.get(pending.action.menuId);
    if (!menu) {
      pending = null;
      continue;
    }

    if (pending.action.kind === "catalog-request") {
      const catalog = parseHermesProviderCatalog(message.content, pending.action.providerSlug);
      if (catalog) {
        hiddenEventIds.add(message.eventId);
        menu.catalogs.set(catalog.providerSlug.toLowerCase(), catalog);
        menu.pendingAction = null;
        menu.failure = null;
        pending = null;
        continue;
      }
    } else {
      const confirmation = parseHermesModelSwitchConfirmation(message.content);
      if (confirmation && confirmation.modelId.toLowerCase() === pending.action.modelId.toLowerCase()) {
        hiddenEventIds.add(message.eventId);
        const catalog = menu.catalogs.get(pending.action.providerSlug.toLowerCase());
        menu.selectedModel = {
          modelId: confirmation.modelId,
          providerSlug: pending.action.providerSlug,
          providerName: confirmation.providerName || catalog?.providerName || pending.action.providerSlug,
        };
        menu.pendingAction = null;
        menu.failure = null;
        pending = null;
        continue;
      }
    }

    menu.pendingAction = null;
    menu.failure = {
      action: pending.action,
      responseEventId: message.eventId,
      responseContent: message.content,
    };
    pending = null;
  }

  return { hiddenEventIds, menusByListingEventId, sessionsByListingEventId };
}

export function buildHermesProviderCatalogPrompt(providerSlug: string): string {
  if (!isValidHermesProviderSlug(providerSlug)) throw new Error("Invalid Hermes provider slug.");
  const slug = providerSlug.trim();
  return `List only the models available for provider slug \`${slug}\` on this Hermes instance. Include every model ID accepted by \`/model <model-id> --provider ${slug}\`, without truncating or omitting any. Do not include API keys, credentials, endpoints, filesystem paths, or other secrets. Return only one fenced JSON code block in this exact shape:\n\n{"provider":"${slug}","models":["model-id"]}`;
}

export function buildHermesModelSwitchCommand(providerSlug: string, modelId: string): string {
  if (!isValidHermesProviderSlug(providerSlug) || !isValidHermesModelId(modelId)) {
    throw new Error("Invalid Hermes model selection.");
  }
  return `/model ${modelId.trim()} --provider ${providerSlug.trim()}`;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

export function pageSlice<T>(values: readonly T[], page: number, pageSize: number): T[] {
  const count = pageCount(values.length, pageSize);
  const safePage = Math.max(0, Math.min(count - 1, Math.floor(page)));
  return values.slice(safePage * pageSize, safePage * pageSize + pageSize);
}
