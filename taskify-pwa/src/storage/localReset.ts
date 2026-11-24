import { idbStorage } from "./idbStorage";
import { deviceStorageMaintenance } from "./kvStorage";

export const LOCAL_RESET_KEY = "taskify.localReset.pending";

export async function requestLocalReset(): Promise<void> {
  // Check that this browser can enumerate account databases before staging the reset.
  await idbStorage.databaseNames();
  deviceStorageMaintenance.write(LOCAL_RESET_KEY, "1");
  window.location.reload();
}

export async function finishLocalReset(): Promise<void> {
  if (!deviceStorageMaintenance.read(LOCAL_RESET_KEY)) return;

  const reset = async () => {
    if (!deviceStorageMaintenance.read(LOCAL_RESET_KEY)) return;
    const names = await idbStorage.databaseNames();
    const registration = await navigator.serviceWorker?.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    await subscription?.unsubscribe();
    const notifications = await registration?.getNotifications?.();
    for (const notification of notifications ?? []) notification.close();
    const databases = names.filter((name) =>
      name === "taskify" || name === "taskify-reminder-titles" || name.startsWith("taskify-account-")
    );
    await Promise.all(databases.map((name) => idbStorage.deleteDatabase(name)));
    deviceStorageMaintenance.removeMatching((key) =>
      key !== LOCAL_RESET_KEY &&
      (/^(taskify[_.:-]|cashu[_.:-])/.test(key) || key === "cashuHistory" || key === "nip51_contacts_migrated_v1")
    );
    deviceStorageMaintenance.removeMatching((key) => key === LOCAL_RESET_KEY);
  };

  // If multiple open tabs reload on the reset request, only one deletes storage.
  if (navigator.locks) await navigator.locks.request(LOCAL_RESET_KEY, reset);
  else await reset();
}
