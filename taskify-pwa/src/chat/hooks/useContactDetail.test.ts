import { expect, test, vi } from "vitest";
import { buildOriginalProfilePhoto } from "./useContactDetail";

test("profile photo processing preserves the original image when canvas is unavailable", async () => {
  const blob = new Blob(["photo"], { type: "image/png" });
  const fetchBlob = vi.fn(async () => blob);

  await expect(
    buildOriginalProfilePhoto(
      "data:image/png;base64,cGhvdG8=",
      { name: "avatar.png", type: "image/png" },
      fetchBlob,
    ),
  ).resolves.toEqual({
    dataUrl: "data:image/png;base64,cGhvdG8=",
    blob,
    contentType: "image/png",
    name: "avatar.png",
  });
  expect(fetchBlob).toHaveBeenCalledWith("data:image/png;base64,cGhvdG8=");
});
