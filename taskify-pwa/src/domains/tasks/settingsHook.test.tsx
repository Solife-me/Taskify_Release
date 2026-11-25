// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { findServerEntry, parseFileServers, serializeFileServers } from "../../lib/fileStorage";
import { kvStorage } from "../../storage/kvStorage";
import { LS_SETTINGS } from "../storageKeys";
import { useSettingsSync, type SetSettingsFn } from "./settingsHook";
import type { Settings } from "./settingsTypes";

const blossom = "https://blossom.solife.me";
const originless = "https://originless.solife.me";
const custom = "https://media.example.test";

let root: Root;
let settings: Settings;
let changeSettings: SetSettingsFn;

function Probe() {
  [settings, changeSettings] = useSettingsSync();
  return null;
}

function mount(saved?: Partial<Settings>) {
  if (saved) kvStorage.setItem(LS_SETTINGS, JSON.stringify(saved));
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => root.unmount());
  kvStorage.removeItem(LS_SETTINGS);
  vi.unstubAllGlobals();
});

test("defaults profile photos and encrypted uploads to Blossom", () => {
  mount();
  expect(settings.fileStorageServer).toBe(blossom);
  expect(findServerEntry(parseFileServers(settings.fileServers), blossom)?.type).toBe("blossom");
  expect(settings.encryptedFileStorageServer).toBe(blossom);
  const servers = parseFileServers(settings.encryptedFileServers);
  expect(findServerEntry(servers, blossom)?.type).toBe("blossom");
  expect(findServerEntry(servers, originless)?.type).toBe("originless");
});

test("persists the upgrade, keeps custom servers, and allows switching back after a reload", () => {
  const encryptedFileServers = serializeFileServers([
    { url: originless, type: "originless" },
    { url: custom, type: "blossom" },
  ]);
  mount({ encryptedFileStorageServer: "ORIGINLESS.solife.me/", encryptedFileServers });
  expect(settings.encryptedFileStorageServer).toBe(blossom);
  expect(parseFileServers(settings.encryptedFileServers).map(({ url }) => url)).toEqual([originless, custom, blossom]);
  expect(JSON.parse(kvStorage.getItem(LS_SETTINGS)!).encryptedFileStorageServer).toBe(blossom);

  act(() => changeSettings({ encryptedFileStorageServer: originless }));
  act(() => root.unmount());
  mount();
  expect(settings.encryptedFileStorageServer).toBe(originless);
});

test("leaves existing public and encrypted server choices selected", () => {
  mount({ encryptedFileStorageServer: custom, fileStorageServer: "https://nostr.build" });
  expect(settings.encryptedFileStorageServer).toBe(custom);
  expect(settings.fileStorageServer).toBe("https://nostr.build");
});

test("upgrades an older synced choice and accepts Originless from an updated client", () => {
  mount();
  const encryptedFileServers = serializeFileServers([{ url: originless, type: "originless" }]);
  const oldSettings = { encryptedFileStorageServer: originless, encryptedFileServers };
  act(() => changeSettings(oldSettings, "backup"));
  expect(settings.encryptedFileStorageServer).toBe(blossom);
  expect(findServerEntry(parseFileServers(settings.encryptedFileServers), blossom)?.type).toBe("blossom");

  act(() => changeSettings(oldSettings, "backup"));
  expect(settings.encryptedFileStorageServer).toBe(blossom);
  expect(findServerEntry(parseFileServers(settings.encryptedFileServers), blossom)?.type).toBe("blossom");

  act(() => changeSettings({ encryptedFileStorageServer: custom }));
  act(() => changeSettings(oldSettings, "backup"));
  expect(settings.encryptedFileStorageServer).toBe(custom);

  act(() => changeSettings({ ...oldSettings, blossomMediaServerMigrated: true }, "backup"));
  expect(settings.encryptedFileStorageServer).toBe(originless);
});
