import type { Settings } from "../../domains/tasks/settingsTypes";
import type { FileServerType } from "../../lib/fileStorage";
import { FileServersSection } from "./FileServersSection";
import { SettingsAccordion } from "./SettingsAccordion";

export function StorageSection({
  settings,
  setSettings,
}: {
  settings: Settings;
  setSettings: (settings: Partial<Settings>) => void;
}) {
  return (
    <div className="space-y-2">
      <SettingsAccordion title="Public file servers" summary="Attachment hosts visible to file-server operators" nested>
        <FileServersSection
          fileStorageServer={settings.fileStorageServer}
          fileServers={settings.fileServers || ""}
          onSelectServer={(url) => setSettings({ fileStorageServer: url })}
          onUpdateServers={(serialized) => setSettings({ fileServers: serialized })}
        />
      </SettingsAccordion>
      <SettingsAccordion title="Encrypted file servers" summary="Hosts for encrypted task and chat attachments" nested>
        <FileServersSection
          fileStorageServer={settings.encryptedFileStorageServer}
          fileServers={settings.encryptedFileServers || ""}
          onSelectServer={(url) => setSettings({ encryptedFileStorageServer: url })}
          onUpdateServers={(serialized) => setSettings({ encryptedFileServers: serialized })}
          addWarning={(type: FileServerType | null) => type && type !== "originless" ? "Warning: NIP-96 and Blossom servers may fail for encrypted uploads. Originless is recommended." : null}
        />
      </SettingsAccordion>
    </div>
  );
}
