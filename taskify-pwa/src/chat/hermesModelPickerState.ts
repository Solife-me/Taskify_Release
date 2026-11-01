import {
  HERMES_MODEL_PAGE_SIZE,
  HERMES_PROVIDER_PAGE_SIZE,
  isValidHermesModelId,
  isValidHermesProviderSlug,
  parseHermesModelListing,
  parseHermesModelSwitchConfirmation,
  parseHermesProviderCatalog,
  type HermesModelListing,
  type HermesProviderCatalog,
  type TaskifyBotUiAction,
} from "taskify-core";
import type { WalletDmMessage } from "./hooks/useDmState";

export { HERMES_MODEL_PAGE_SIZE, HERMES_PROVIDER_PAGE_SIZE };

export const HERMES_CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;

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
};

const EMPTY_PROJECTION: HermesBotUiProjection = {
  hiddenEventIds: new Set(),
  menusByListingEventId: new Map(),
};

function stableMenuId(message: WalletDmMessage): string | null {
  const candidate = (message.rumorEventId || message.eventId || "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : null;
}

function isPlainTextMessage(message: WalletDmMessage): boolean {
  return !message.attachment || message.attachment.type === "text";
}

/**
 * Reconstruct every Hermes model menu from the encrypted message history.
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
  const menusByMenuId = new Map<string, HermesMenuProjection>();

  for (const message of ordered) {
    if (!message.isIncoming || message.groupId || !isPlainTextMessage(message)) continue;
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

  if (!menusByMenuId.size) return { hiddenEventIds, menusByListingEventId };

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

  return { hiddenEventIds, menusByListingEventId };
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

export type HermesCatalogCacheEntry = {
  providerSlug: string;
  providerName: string | null;
  models: string[];
  fetchedAt: number;
  listingId: string;
};

export const LS_HERMES_MODEL_CATALOG_CACHE = "taskify_hermes_model_catalog_cache_v1";

type CatalogCacheMap = Record<string, HermesCatalogCacheEntry>;

function catalogCacheKey(peerPubkey: string, providerSlug: string): string {
  return `${peerPubkey.trim().toLowerCase()}|${providerSlug.trim().toLowerCase()}`;
}

function loadCatalogCacheMap(): CatalogCacheMap {
  try {
    const raw = window.localStorage.getItem(LS_HERMES_MODEL_CATALOG_CACHE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CatalogCacheMap : {};
  } catch {
    return {};
  }
}

function persistCatalogCacheMap(map: CatalogCacheMap): void {
  try {
    window.localStorage.setItem(LS_HERMES_MODEL_CATALOG_CACHE, JSON.stringify(map));
  } catch {
    // A full or unavailable cache only causes the picker to request a fresh catalog.
  }
}

function isCacheEntry(value: unknown): value is HermesCatalogCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<HermesCatalogCacheEntry>;
  return (
    typeof entry.providerSlug === "string" &&
    isValidHermesProviderSlug(entry.providerSlug) &&
    (entry.providerName === null || typeof entry.providerName === "string") &&
    Array.isArray(entry.models) &&
    entry.models.every(isValidHermesModelId) &&
    typeof entry.fetchedAt === "number" &&
    Number.isFinite(entry.fetchedAt) &&
    typeof entry.listingId === "string"
  );
}

export function loadHermesCatalogCache(
  peerPubkey: string,
  listingId: string,
  providerSlug: string,
): HermesCatalogCacheEntry | null {
  const key = catalogCacheKey(peerPubkey, providerSlug);
  const entry = loadCatalogCacheMap()[key];
  if (!isCacheEntry(entry)) return null;
  if (entry.providerSlug.toLowerCase() !== providerSlug.toLowerCase()) return null;
  return entry;
}

export function isHermesCatalogCacheFresh(
  entry: HermesCatalogCacheEntry,
  now = Date.now(),
  currentListingId?: string,
): boolean {
  return (!currentListingId || entry.listingId === currentListingId)
    && now - entry.fetchedAt >= 0
    && now - entry.fetchedAt < HERMES_CATALOG_CACHE_TTL_MS;
}

export function saveHermesCatalogCache(
  peerPubkey: string,
  listingId: string,
  catalog: HermesProviderCatalog,
  fetchedAt = Date.now(),
): HermesCatalogCacheEntry {
  const entry: HermesCatalogCacheEntry = {
    providerSlug: catalog.providerSlug,
    providerName: catalog.providerName,
    models: [...catalog.models],
    fetchedAt,
    listingId,
  };
  const map = loadCatalogCacheMap();
  map[catalogCacheKey(peerPubkey, catalog.providerSlug)] = entry;
  persistCatalogCacheMap(map);
  return entry;
}
