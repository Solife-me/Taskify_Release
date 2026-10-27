import { expect, test, vi } from "vitest";

const release = vi.fn();
let resolveSubscribe: ((managed: { release: () => void }) => void) | null = null;
vi.mock("./NostrSession", () => ({
  NostrSession: {
    init: async () => ({
      subscribe: () => new Promise((resolve) => { resolveSubscribe = resolve; }),
    }),
  },
}));

const { SessionPool } = await import("./SessionPool");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("closing before the subscription is ready still releases it once it arrives", async () => {
  release.mockReset();
  const close = new SessionPool().subscribe(["wss://r"], [{ kinds: [1] }], () => {});
  close(); // the component unmounted while the session was starting
  await flush();
  resolveSubscribe?.({ release });
  await flush();
  expect(release).toHaveBeenCalledTimes(1);
});

test("an open subscription is not released until closed", async () => {
  release.mockReset();
  const close = new SessionPool().subscribe(["wss://r"], [{ kinds: [1] }], () => {});
  await flush();
  resolveSubscribe?.({ release });
  await flush();
  expect(release).not.toHaveBeenCalled();
  close();
  expect(release).toHaveBeenCalledTimes(1);
});

test("subscribeMany follows the same rule", async () => {
  release.mockReset();
  const { close } = new SessionPool().subscribeMany(["wss://r"], { kinds: [1] });
  close();
  await flush();
  resolveSubscribe?.({ release });
  await flush();
  expect(release).toHaveBeenCalledTimes(1);
});
