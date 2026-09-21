export async function checkRelay(url: string, timeoutMs: number = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const timer = setTimeout(() => {
      ws.close();
      done(false);
    }, timeoutMs);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        done(true);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        done(false);
      };
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}
