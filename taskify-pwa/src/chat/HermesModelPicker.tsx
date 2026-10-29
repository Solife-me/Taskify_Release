import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HermesProviderCatalog, TaskifyBotUiAction } from "taskify-core";
import {
  HERMES_MODEL_PAGE_SIZE,
  HERMES_PROVIDER_PAGE_SIZE,
  buildHermesModelSwitchCommand,
  buildHermesProviderCatalogPrompt,
  isHermesCatalogCacheFresh,
  loadHermesCatalogCache,
  pageCount,
  pageSlice,
  saveHermesCatalogCache,
  type HermesMenuProjection,
} from "./hermesModelPickerState";

type PickerView =
  | { kind: "overview" }
  | { kind: "providers" }
  | { kind: "models"; providerSlug: string };

type CachedCatalogView = {
  catalog: HermesProviderCatalog;
  fetchedAt: number;
  listingId: string;
};

export type HermesModelPickerProps = {
  peerPubkey: string;
  projection: HermesMenuProjection;
  sendBotUiCommand: (
    peerPubkey: string,
    content: string,
    action: TaskifyBotUiAction,
  ) => Promise<void>;
};

function providerLabel(name: string | null | undefined, slug: string): string {
  return name?.trim() || slug;
}

function clampPage(page: number, total: number, pageSize: number): number {
  return Math.max(0, Math.min(pageCount(total, pageSize) - 1, page));
}

export function HermesModelPicker({ peerPubkey, projection, sendBotUiCommand }: HermesModelPickerProps) {
  const { listing, listingEventId, menuId } = projection;
  const [view, setView] = useState<PickerView>({ kind: "overview" });
  const [providerPage, setProviderPage] = useState(0);
  const [modelPage, setModelPage] = useState(0);
  const [catalogs, setCatalogs] = useState<Map<string, CachedCatalogView>>(() => new Map());
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [switchingModel, setSwitchingModel] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const selectedModelKey = projection.selectedModel
    ? `${projection.selectedModel.providerSlug}|${projection.selectedModel.modelId}`
    : null;
  const lastSelectedModelKeyRef = useRef<string | null>(selectedModelKey);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setView({ kind: "overview" });
    setProviderPage(0);
    setModelPage(0);
    setLoadingProvider(null);
    setSwitchingModel(null);
    setActionError(null);
    setCatalogs(new Map());
    lastSelectedModelKeyRef.current = selectedModelKey;
  }, [listingEventId, selectedModelKey]);

  useEffect(() => {
    if (!projection.catalogs.size) return;
    const fetchedAt = Date.now();
    setCatalogs((previous) => {
      const next = new Map(previous);
      for (const [slug, catalog] of projection.catalogs) {
        const existing = next.get(slug);
        if (!existing || existing.catalog !== catalog) {
          next.set(slug, { catalog, fetchedAt, listingId: listingEventId });
          saveHermesCatalogCache(peerPubkey, listingEventId, catalog, fetchedAt);
        }
      }
      return next;
    });
    setLoadingProvider(null);
    setActionError(null);
  }, [listingEventId, peerPubkey, projection.catalogs]);

  useEffect(() => {
    if (!projection.selectedModel) return;
    const key = `${projection.selectedModel.providerSlug}|${projection.selectedModel.modelId}`;
    if (key !== lastSelectedModelKeyRef.current) {
      lastSelectedModelKeyRef.current = key;
      setView({ kind: "overview" });
      setSwitchingModel(null);
      setActionError(null);
    }
  }, [projection.selectedModel]);

  useEffect(() => {
    if (projection.failure) {
      setLoadingProvider(null);
      setSwitchingModel(null);
      setActionError("Hermes replied in an unexpected format. The raw response is shown below, and you can retry.");
    }
  }, [projection.failure]);

  const requestCatalog = useCallback(async (providerSlug: string) => {
    if (!mountedRef.current) return;
    setLoadingProvider(providerSlug);
    setActionError(null);
    try {
      await sendBotUiCommand(peerPubkey, buildHermesProviderCatalogPrompt(providerSlug), {
        kind: "catalog-request",
        menuId,
        providerSlug,
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setLoadingProvider(null);
      setActionError(error instanceof Error ? error.message : "Could not request the provider catalog.");
    }
  }, [menuId, peerPubkey, sendBotUiCommand]);

  const rememberCache = useCallback((providerSlug: string, entry: ReturnType<typeof loadHermesCatalogCache>) => {
    if (!entry) return;
    setCatalogs((previous) => {
      if (previous.has(providerSlug)) return previous;
      const next = new Map(previous);
      next.set(providerSlug, {
        catalog: {
          providerName: entry.providerName,
          providerSlug: entry.providerSlug,
          models: entry.models,
        },
        fetchedAt: entry.fetchedAt,
        listingId: entry.listingId,
      });
      return next;
    });
  }, []);

  const openProvider = useCallback((providerSlug: string) => {
    setView({ kind: "models", providerSlug });
    setModelPage(0);
    setActionError(null);
    const liveCatalog = projection.catalogs.get(providerSlug);
    const cacheEntry = loadHermesCatalogCache(peerPubkey, listingEventId, providerSlug);
    rememberCache(providerSlug, cacheEntry);
    const hasAnyCatalog = !!liveCatalog || !!cacheEntry;
    const isFresh = !!liveCatalog || (!!cacheEntry && isHermesCatalogCacheFresh(cacheEntry, Date.now(), listingEventId));
    if (!hasAnyCatalog || !isFresh) {
      void requestCatalog(providerSlug);
    }
  }, [listingEventId, peerPubkey, projection.catalogs, rememberCache, requestCatalog]);

  const refreshProvider = useCallback((providerSlug: string) => {
    if (projection.pendingAction) return;
    void requestCatalog(providerSlug);
  }, [projection.pendingAction, requestCatalog]);

  const switchModel = useCallback(async (providerSlug: string, modelId: string) => {
    if (projection.pendingAction) return;
    setSwitchingModel(modelId);
    setActionError(null);
    try {
      await sendBotUiCommand(peerPubkey, buildHermesModelSwitchCommand(providerSlug, modelId), {
        kind: "model-select",
        menuId,
        providerSlug,
        modelId,
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setSwitchingModel(null);
      setActionError(error instanceof Error ? error.message : "Could not switch the model.");
    }
  }, [menuId, peerPubkey, projection.pendingAction, sendBotUiCommand]);

  useEffect(() => {
    if (!projection.pendingAction) return;
    if (projection.pendingAction.kind === "catalog-request") {
      setLoadingProvider(projection.pendingAction.providerSlug);
    } else {
      setSwitchingModel(projection.pendingAction.modelId);
    }
  }, [projection.pendingAction]);

  const providers = listing.providers;
  const safeProviderPage = clampPage(providerPage, providers.length, HERMES_PROVIDER_PAGE_SIZE);
  const providerRows = pageSlice(providers, safeProviderPage, HERMES_PROVIDER_PAGE_SIZE);
  const activeProvider = view.kind === "models"
    ? providers.find((provider) => provider.slug === view.providerSlug) ?? null
    : null;
  const activeCatalogView = activeProvider
    ? catalogs.get(activeProvider.slug) ?? null
    : null;
  const liveCatalog = activeProvider ? projection.catalogs.get(activeProvider.slug) ?? null : null;
  const modelValues = liveCatalog?.models || activeCatalogView?.catalog.models || [];
  const safeModelPage = clampPage(modelPage, modelValues.length, HERMES_MODEL_PAGE_SIZE);
  const modelRows = pageSlice(modelValues, safeModelPage, HERMES_MODEL_PAGE_SIZE);
  const activeProviderLoading = !!activeProvider && loadingProvider === activeProvider.slug;
  const activeProviderStale = !!activeCatalogView &&
    !isHermesCatalogCacheFresh({
      providerSlug: activeCatalogView.catalog.providerSlug,
      providerName: activeCatalogView.catalog.providerName,
      models: activeCatalogView.catalog.models,
      fetchedAt: activeCatalogView.fetchedAt,
      listingId: activeCatalogView.listingId,
    }, Date.now(), listingEventId);
  const showConfirmation = view.kind === "overview" && !!projection.selectedModel;
  const currentLabel = projection.selectedModel?.modelId || listing.currentModel || "Model not reported";
  const currentProviderSlug = projection.selectedModel?.providerSlug || listing.currentProviderSlug;
  const currentProvider = providers.find((provider) => provider.slug === currentProviderSlug);
  const currentProviderLabel = projection.selectedModel?.providerName || currentProvider?.name || currentProviderSlug;

  const requestInFlight = !!projection.pendingAction || !!loadingProvider || !!switchingModel;

  const providerContent = useMemo(() => {
    const total = providers.length;
    const first = total ? safeProviderPage * HERMES_PROVIDER_PAGE_SIZE + 1 : 0;
    const last = Math.min(total, (safeProviderPage + 1) * HERMES_PROVIDER_PAGE_SIZE);
    return (
      <>
        <div className="hermes-model-picker__section-head">
          <span>Select a provider</span>
          <span>{total ? `${first}–${last} of ${total}` : "None reported"}</span>
        </div>
        <div className="hermes-model-picker__provider-grid">
          {providerRows.map((provider) => (
            <button
              key={provider.slug}
              type="button"
              className={`hermes-model-picker__provider pressable${provider.isCurrent ? " is-current" : ""}`}
              onClick={() => openProvider(provider.slug)}
              disabled={requestInFlight}
              aria-label={`${provider.name}, ${provider.totalModels} models${provider.isCurrent ? ", current provider" : ""}`}
            >
              <span className="hermes-model-picker__provider-name">
                {provider.isCurrent && <span className="hermes-model-picker__check" aria-hidden="true">✓</span>}
                {provider.name}
              </span>
              <span className="hermes-model-picker__provider-count">{provider.totalModels}</span>
            </button>
          ))}
        </div>
        <div className="hermes-model-picker__footer">
          <button
            type="button"
            className="hermes-model-picker__control pressable"
            onClick={() => setProviderPage((page) => Math.max(0, page - 1))}
            disabled={safeProviderPage <= 0 || requestInFlight}
          >
            ◀ Prev
          </button>
          <button
            type="button"
            className="hermes-model-picker__control pressable"
            onClick={() => setProviderPage((page) => Math.min(pageCount(total, HERMES_PROVIDER_PAGE_SIZE) - 1, page + 1))}
            disabled={safeProviderPage >= pageCount(total, HERMES_PROVIDER_PAGE_SIZE) - 1 || requestInFlight}
          >
            Next ▶
          </button>
          {projection.selectedModel ? (
            <button
              type="button"
              className="hermes-model-picker__control hermes-model-picker__control--wide pressable"
              onClick={() => setView({ kind: "overview" })}
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              className="hermes-model-picker__control hermes-model-picker__control--wide pressable"
              onClick={() => setView({ kind: "overview" })}
            >
              Cancel
            </button>
          )}
        </div>
      </>
    );
  }, [openProvider, projection.selectedModel, providerRows, providers.length, requestInFlight, safeProviderPage]);

  return (
    <div className="hermes-model-picker" aria-label="Hermes model configuration">
      <div className="hermes-model-picker__title-row">
        <span className="hermes-model-picker__gear" aria-hidden="true">⚙</span>
        <div className="hermes-model-picker__title-copy">
          <div className="hermes-model-picker__title">Model configuration</div>
          <div className="hermes-model-picker__current" title={currentLabel}>
            <span>{currentLabel}</span>
            {currentProviderLabel && <span className="hermes-model-picker__current-provider">{currentProviderLabel}</span>}
          </div>
        </div>
      </div>

      {showConfirmation ? (
        <div className="hermes-model-picker__confirmation" role="status">
          <div className="hermes-model-picker__confirmation-icon" aria-hidden="true">✓</div>
          <div className="hermes-model-picker__confirmation-copy">
            <div className="hermes-model-picker__confirmation-label">Current model</div>
            <div className="hermes-model-picker__confirmation-model">{projection.selectedModel?.modelId}</div>
            <div className="hermes-model-picker__confirmation-provider">
              {projection.selectedModel?.providerName || projection.selectedModel?.providerSlug}
            </div>
          </div>
          <button
            type="button"
            className="hermes-model-picker__control hermes-model-picker__change pressable"
            onClick={() => setView({ kind: "providers" })}
          >
            Change
          </button>
        </div>
      ) : view.kind === "providers" || (view.kind === "overview" && !projection.selectedModel) ? (
        providerContent
      ) : activeProvider ? (
        <>
          <div className="hermes-model-picker__models-head">
            <button
              type="button"
              className="hermes-model-picker__back pressable"
              onClick={() => {
                setView({ kind: "providers" });
                setModelPage(0);
                setActionError(null);
              }}
            >
              ◀ Back
            </button>
            <div className="hermes-model-picker__selected-provider">
              <span>{providerLabel(activeProvider.name, activeProvider.slug)}</span>
              <span>
                {modelValues.length
                  ? `${safeModelPage * HERMES_MODEL_PAGE_SIZE + 1}–${Math.min(modelValues.length, (safeModelPage + 1) * HERMES_MODEL_PAGE_SIZE)} of ${modelValues.length}`
                  : activeProviderLoading
                    ? "Loading…"
                    : "No models loaded"}
              </span>
            </div>
          </div>

          {modelRows.length > 0 ? (
            <div className="hermes-model-picker__model-grid" aria-busy={activeProviderLoading}>
              {modelRows.map((model) => (
                <button
                  key={model}
                  type="button"
                  className="hermes-model-picker__model pressable"
                  title={model}
                  onClick={() => void switchModel(activeProvider.slug, model)}
                  disabled={requestInFlight}
                >
                  <span>{model}</span>
                  {switchingModel === model && <span className="hermes-model-picker__spinner" aria-label="Switching" />}
                </button>
              ))}
            </div>
          ) : (
            <div className="hermes-model-picker__empty" role="status">
              {activeProviderLoading
                ? `Loading ${activeProvider.name} models…`
                : "No models were returned for this provider."}
            </div>
          )}

          {activeProviderLoading && modelRows.length > 0 && (
            <div className="hermes-model-picker__status" role="status">
              <span className="hermes-model-picker__spinner" aria-hidden="true" />
              Refreshing model list…
            </div>
          )}
          {activeProviderStale && !activeProviderLoading && (
            <div className="hermes-model-picker__status">Cached list · refresh to check for new models</div>
          )}
          {actionError && <div className="hermes-model-picker__error" role="alert">{actionError}</div>}
          {projection.failure && (
            <div className="hermes-model-picker__error" role="alert">
              Couldn’t read Hermes’s response.
              <button
                type="button"
                className="hermes-model-picker__inline-retry pressable"
                onClick={() => refreshProvider(activeProvider.slug)}
                disabled={requestInFlight}
              >
                Retry
              </button>
            </div>
          )}

          <div className="hermes-model-picker__footer">
            <button
              type="button"
              className="hermes-model-picker__control pressable"
              onClick={() => setModelPage((page) => Math.max(0, page - 1))}
              disabled={safeModelPage <= 0 || requestInFlight}
            >
              ◀ Prev
            </button>
            <button
              type="button"
              className="hermes-model-picker__control pressable"
              onClick={() => setModelPage((page) => Math.min(pageCount(modelValues.length, HERMES_MODEL_PAGE_SIZE) - 1, page + 1))}
              disabled={safeModelPage >= pageCount(modelValues.length, HERMES_MODEL_PAGE_SIZE) - 1 || requestInFlight}
            >
              Next ▶
            </button>
            <button
              type="button"
              className="hermes-model-picker__control pressable"
              onClick={() => refreshProvider(activeProvider.slug)}
              disabled={requestInFlight}
            >
              Refresh
            </button>
            <button
              type="button"
              className="hermes-model-picker__control pressable"
              onClick={() => {
                setView({ kind: projection.selectedModel ? "overview" : "providers" });
                setActionError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
