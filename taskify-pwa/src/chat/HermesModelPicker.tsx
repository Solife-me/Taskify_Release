import { useEffect, useRef, useState } from "react";
import type { TaskifyBotUiAction } from "taskify-core";
import {
  HERMES_MODEL_PAGE_SIZE,
  HERMES_PROVIDER_PAGE_SIZE,
  buildHermesModelSwitchCommand,
  pageCount,
  pageSlice,
  type HermesMenuProjection,
} from "./hermesModelPickerState";

type PickerView =
  | { kind: "overview" }
  | { kind: "providers" }
  | { kind: "models"; providerSlug: string };

export type HermesModelPickerProps = {
  peerPubkey: string;
  projection: HermesMenuProjection;
  sendBotUiCommand: (
    peerPubkey: string,
    content: string,
    action: TaskifyBotUiAction,
    bind?: boolean,
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
  const [switchingModel, setSwitchingModel] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const activeSwitch = useRef<{ model: string } | null>(null);
  const selectedModelKey = projection.selectedModel
    ? `${projection.selectedModel.providerSlug}|${projection.selectedModel.modelId}`
    : null;

  useEffect(() => {
    setView({ kind: "overview" });
    setProviderPage(0);
    setModelPage(0);
    setSwitchingModel(null);
    setActionError(null);
    return () => { activeSwitch.current = null; };
  }, [listingEventId, selectedModelKey]);

  useEffect(() => {
    const failure = projection.failure;
    if (failure?.action.kind !== "model-select" || failure.action.modelId !== activeSwitch.current?.model) return;
    activeSwitch.current = null;
    setSwitchingModel(null);
    setActionError("Hermes replied in an unexpected format. Its response is shown in the chat.");
  }, [projection.failure]);

  useEffect(() => {
    if (!switchingModel) return;
    const request = activeSwitch.current;
    const timeout = window.setTimeout(() => {
      if (activeSwitch.current !== request) return;
      activeSwitch.current = null;
      setSwitchingModel(null);
      setActionError("Hermes hasn’t confirmed the switch. Tap the model to retry.");
    }, 15_000);
    return () => window.clearTimeout(timeout);
  }, [switchingModel]);

  function openProvider(providerSlug: string) {
    setView({ kind: "models", providerSlug });
    setModelPage(0);
    setActionError(null);
  }

  async function switchModel(providerSlug: string, modelId: string) {
    if (activeSwitch.current) return;
    const request = { model: modelId };
    activeSwitch.current = request;
    setSwitchingModel(modelId);
    setActionError(null);
    try {
      await sendBotUiCommand(peerPubkey, buildHermesModelSwitchCommand(providerSlug, modelId), {
        kind: "model-select",
        menuId,
        providerSlug,
        modelId,
      }, ...(projection.bindsActionsToListing ? [true] as const : []));
    } catch (error) {
      if (activeSwitch.current !== request) return;
      activeSwitch.current = null;
      setSwitchingModel(null);
      setActionError(error instanceof Error ? error.message : "Could not switch the model.");
    }
  }

  const providers = listing.providers;
  const safeProviderPage = clampPage(providerPage, providers.length, HERMES_PROVIDER_PAGE_SIZE);
  const providerRows = pageSlice(providers, safeProviderPage, HERMES_PROVIDER_PAGE_SIZE);
  const activeProvider = view.kind === "models"
    ? providers.find((provider) => provider.slug === view.providerSlug) ?? null
    : null;
  const modelValues = activeProvider?.previewModels ?? [];
  const safeModelPage = clampPage(modelPage, modelValues.length, HERMES_MODEL_PAGE_SIZE);
  const modelRows = pageSlice(modelValues, safeModelPage, HERMES_MODEL_PAGE_SIZE);
  const showConfirmation = view.kind === "overview" && !!projection.selectedModel;
  const currentLabel = projection.selectedModel?.modelId || listing.currentModel || "Model not reported";
  const currentProviderSlug = projection.selectedModel?.providerSlug || listing.currentProviderSlug;
  const currentProvider = providers.find((provider) => provider.slug === currentProviderSlug);
  const currentProviderLabel = projection.selectedModel?.providerName || currentProvider?.name || currentProviderSlug;

  const requestInFlight = switchingModel !== null;


  const total = providers.length;
  const first = total ? safeProviderPage * HERMES_PROVIDER_PAGE_SIZE + 1 : 0;
  const last = Math.min(total, (safeProviderPage + 1) * HERMES_PROVIDER_PAGE_SIZE);
  const providerContent = (
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
                  : "No model IDs listed"}
              </span>
            </div>
          </div>

          {modelRows.length > 0 ? (
            <div className="hermes-model-picker__model-grid" aria-busy={requestInFlight}>
              {modelRows.map((model) => (
                <button
                  key={model}
                  type="button"
                  className="hermes-model-picker__model pressable"
                  title={model}
                  onClick={() => void switchModel(activeProvider.slug, model)}
                  disabled={requestInFlight || (currentProviderSlug === activeProvider.slug && currentLabel === model)}
                >
                  <span>{model}</span>
                  {switchingModel === model && <span className="hermes-model-picker__spinner" aria-label="Switching" />}
                </button>
              ))}
            </div>
          ) : (
            <div className="hermes-model-picker__empty" role="status">
              Hermes did not list model IDs for this provider.
            </div>
          )}

          {modelValues.length > 0 && modelValues.length < activeProvider.totalModels && (
            <div className="hermes-model-picker__status">
              Hermes listed {modelValues.length} of {activeProvider.totalModels} models.
            </div>
          )}
          {actionError && <div className="hermes-model-picker__error" role="alert">{actionError}</div>}

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
