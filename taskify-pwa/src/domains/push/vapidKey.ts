export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  if (!base64String || typeof base64String !== 'string') {
    throw new Error('VAPID public key is missing.');
  }
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const decode = typeof atob === 'function'
    ? atob
    : (() => { throw new Error('No base64 decoder available in this environment'); });
  try {
    const rawData = decode(base64);
    if (!rawData) throw new Error('Decoded key was empty');
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    if (outputArray.length < 32) {
      throw new Error('Decoded key is too short');
    }
    return outputArray;
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Invalid VAPID public key: ${err.message}`);
    }
    throw new Error('Invalid VAPID public key.');
  }
}
