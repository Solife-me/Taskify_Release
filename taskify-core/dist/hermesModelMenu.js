/**
 * Taskify's Hermes model-menu adapter.
 *
 * Hermes has no structured UI callback on non-Telegram platforms. Its `/model` text fallback
 * carries provider previews, while a one-provider agent request can return a complete JSON
 * catalog. These parsers are deliberately strict: clients should render buttons only from values
 * that were recognized in a known Hermes response shape.
 */
export const HERMES_PROVIDER_PAGE_SIZE = 10;
export const HERMES_MODEL_PAGE_SIZE = 8;
const PROVIDER_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/;
export function isValidHermesProviderSlug(value) {
    return typeof value === "string" && PROVIDER_SLUG_PATTERN.test(value.trim());
}
export function isValidHermesModelId(value) {
    return typeof value === "string" && MODEL_ID_PATTERN.test(value.trim());
}
function cleanLabel(value, limit = 120) {
    if (typeof value !== "string")
        return "";
    return value
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit);
}
function uniqueModels(values) {
    const models = [];
    const seen = new Set();
    for (const value of values) {
        if (!isValidHermesModelId(value))
            continue;
        const model = value.trim();
        const key = model.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        models.push(model);
    }
    return models;
}
function codeSpans(value) {
    return Array.from(value.matchAll(/`([^`\n]+)`/g), (match) => match[1]?.trim() || "").filter(Boolean);
}
function providerHeading(line) {
    const match = line.match(/^\s*\*\*(.+?)\*\*\s+`--provider\s+([^`\s]+)`(.*)$/);
    if (!match)
        return null;
    const name = cleanLabel(match[1]);
    const slug = match[2]?.trim() || "";
    const tail = match[3] || "";
    if (!name || !isValidHermesProviderSlug(slug))
        return null;
    if (!tail.includes(":") && !/\(current\)/i.test(tail))
        return null;
    return { name, slug, isCurrent: /\(current\)/i.test(tail) };
}
export function parseHermesModelListing(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const headings = lines
        .map((line, index) => ({ line, index, parsed: providerHeading(line) }))
        .filter((entry) => !!entry.parsed);
    if (!headings.length)
        return null;
    const providers = [];
    const seen = new Set();
    for (const [index, heading] of headings.entries()) {
        const boundary = headings[index + 1]?.index
            ?? lines.findIndex((line, lineIndex) => lineIndex > heading.index && /^\s*`\/model\b/.test(line));
        const end = boundary < 0 ? lines.length : boundary;
        const block = lines.slice(heading.index + 1, end).join("\n");
        const previewModels = uniqueModels(codeSpans(block));
        const hiddenMatch = block.match(/\(\+(\d+)\s+more\)/i);
        const hidden = hiddenMatch?.[1] ? Number.parseInt(hiddenMatch[1], 10) : 0;
        const key = heading.parsed.slug.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        providers.push({
            ...heading.parsed,
            previewModels,
            totalModels: previewModels.length + (Number.isFinite(hidden) ? hidden : 0),
        });
    }
    if (!providers.length)
        return null;
    const currentMatch = String(text || "").match(/^\s*Current:\s*`([^`\n]+)`\s+on\s+([^\s`]+)\s*$/m);
    const currentModel = currentMatch?.[1] && isValidHermesModelId(currentMatch[1]) ? currentMatch[1].trim() : null;
    const currentProviderSlug = currentMatch?.[2] && isValidHermesProviderSlug(currentMatch[2])
        ? currentMatch[2].trim()
        : providers.find((provider) => provider.isCurrent)?.slug ?? null;
    return { currentModel, currentProviderSlug, providers };
}
function jsonObjectText(text) {
    const raw = String(text || "").trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] || raw).trim();
    if (!candidate)
        return null;
    if (candidate.startsWith("{") && candidate.endsWith("}"))
        return candidate;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    return start >= 0 && end > start ? candidate.slice(start, end + 1) : null;
}
function catalogCandidate(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";
    if (!isValidHermesProviderSlug(slug) || !Array.isArray(row.models))
        return null;
    return { name: cleanLabel(row.name) || null, slug, models: row.models };
}
export function parseHermesProviderCatalog(text, expectedProviderSlug) {
    const json = jsonObjectText(text);
    if (!json)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const root = parsed;
    const expected = expectedProviderSlug?.trim().toLowerCase() || "";
    let candidate = null;
    if (typeof root.provider === "string" && Array.isArray(root.models)) {
        const slug = root.provider.trim();
        if (!isValidHermesProviderSlug(slug))
            return null;
        if (expected && slug.toLowerCase() !== expected)
            return null;
        candidate = { name: cleanLabel(root.name) || null, slug, models: root.models };
    }
    else if (Array.isArray(root.providers)) {
        const rows = root.providers.map(catalogCandidate).filter((row) => !!row);
        if (expected)
            candidate = rows.find((row) => row.slug.toLowerCase() === expected) ?? null;
        else if (rows.length === 1)
            candidate = rows[0];
    }
    if (!candidate)
        return null;
    return {
        providerName: candidate.name,
        providerSlug: candidate.slug,
        models: uniqueModels(candidate.models),
    };
}
export function parseHermesModelSwitchConfirmation(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    let modelId = null;
    let providerName = null;
    for (const line of lines) {
        const modelMatch = line.match(/^\s*Model switched to\s+`?([^`\n]+?)`?\s*$/i);
        if (modelMatch?.[1] && isValidHermesModelId(modelMatch[1]))
            modelId = modelMatch[1].trim();
        const providerMatch = line.match(/^\s*Provider:\s*(.+?)\s*$/i);
        if (providerMatch?.[1])
            providerName = cleanLabel(providerMatch[1]) || null;
    }
    return modelId ? { modelId, providerName } : null;
}
/** Encrypted rumor tags used to hide Taskify bot-UI commands and correlate their replies. */
export const TASKIFY_BOT_UI_TAG = "taskify-bot-ui";
export const TASKIFY_BOT_UI_VERSION = "v1";
const MENU_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
function validMenuId(value) {
    return typeof value === "string" && MENU_ID_PATTERN.test(value);
}
export function buildTaskifyBotUiActionTag(action) {
    if (!validMenuId(action.menuId) || !isValidHermesProviderSlug(action.providerSlug)) {
        throw new Error("Invalid Taskify bot UI action.");
    }
    if (action.kind === "catalog-request") {
        return [TASKIFY_BOT_UI_TAG, TASKIFY_BOT_UI_VERSION, action.kind, action.menuId, action.providerSlug.trim()];
    }
    if (!isValidHermesModelId(action.modelId))
        throw new Error("Invalid Taskify bot UI model.");
    return [
        TASKIFY_BOT_UI_TAG,
        TASKIFY_BOT_UI_VERSION,
        action.kind,
        action.menuId,
        action.providerSlug.trim(),
        action.modelId.trim(),
    ];
}
export function parseTaskifyBotUiAction(tags) {
    if (!Array.isArray(tags))
        return null;
    for (const tag of tags) {
        if (!Array.isArray(tag) || tag[0] !== TASKIFY_BOT_UI_TAG || tag[1] !== TASKIFY_BOT_UI_VERSION)
            continue;
        const kind = tag[2];
        const menuId = tag[3];
        const providerSlug = typeof tag[4] === "string" ? tag[4].trim() : "";
        if (!validMenuId(menuId) || !isValidHermesProviderSlug(providerSlug))
            continue;
        if (kind === "catalog-request" && tag.length === 5) {
            return { kind, menuId, providerSlug };
        }
        if (kind === "model-select" && tag.length === 6) {
            const modelId = typeof tag[5] === "string" ? tag[5].trim() : "";
            if (isValidHermesModelId(modelId))
                return { kind, menuId, providerSlug, modelId };
        }
    }
    return null;
}
