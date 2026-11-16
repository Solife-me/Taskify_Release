# Physical checklist orientation scan regression — 2026-11-16

## Reproduction

A checklist printed by the PWA with layout v4 was marked on paper and scanned from the iOS board
sheet. The iOS scan reported that no checklist was recognized even though the photo contained all
four registration markers, the print code, and a clearly marked task.

## Root cause

The iOS camera-to-grayscale conversion applied a vertical flip to the bitmap context before drawing
the document image. The scanner received every page upside down. Its clockwise rotation fallback
cannot undo a mirror, so marker selection landed on text and the print code was read as blank. A
second geometry issue made the review unsafe once recognition was restored: the PWA's printed
circles can sit about a millimetre off the native grid, causing blank rings to look filled.

## Resolution

- Camera images now enter the shared grayscale buffer in display order through
  `PhysicalChecklistGrayImage.from(cgImage:targetWidth:)`.
- The scan analyzer delegates to the perspective-aware marker/homography engine instead of sampling
  the raw page rectangle.
- Each printed circle is recentered on its outline before its interior is classified, so registration
  drift does not create false completed tasks.
- Regression tests cover grayscale row orientation and a shifted, checked circle.

The supplied v4 photograph now recognizes one page and exactly the one marked task.

## Follow-up

A second supplied scan had already been cropped and cleaned by the iOS document scanner, but its
valid registration markers averaged about 167 luma against a 253-luma page. The engine's absolute
145-luma marker ceiling rejected that sheet before reading its valid print code. The ceiling now
allows faded toner up to 210 luma while retaining the separate marker-contrast and print-code
checks. Blank lower-page noise could also satisfy the old four-pixel check/X span rule, so stroke
detection now requires at least ten dark samples. The second scan recognizes one page and only the
marked task.

Build 209 then exposed an identity mismatch rather than an image-reading failure. Print-job owner
IDs were stored case-sensitively, and the scanner only loaded the exact current board key before
falling back to a newly generated native print ID. Owner lookup is now case-insensitive, and the
scanner tries equivalent cached print jobs with the same board title, using the encoded print code
to select the correct task mapping. This covers PWA boards that sync with differently-cased or
client-local owner keys.

The PWA and iOS clients may also be signed in with different identities while sharing the same
board. Encrypted account-backup print manifests are identity-scoped, so the iOS client cannot
receive that manifest. When no matching manifest exists, the scanner now reconstructs the printed
v4 board order from the shared board's tasks and due/note detail lines, scans without requiring the
foreign identity's print code, and sends the detected task through the normal verification screen
before applying it.

Tasks can also be completed in the app after the sheet is printed. The fallback therefore builds
candidate row sets from completion timestamps, runs Vision OCR on the scanned title column, and
uses normalized title similarity plus row proximity to rank the candidates. OCR is an alignment
signal, not the sole identity source: the marked circle still comes from the versioned print
geometry and the user reviews the detected task before it is applied.

The marked rows receive a second, stronger OCR check. A shifted candidate can contain several
false-positive circle readings even when its page-wide title score is respectable; scoring the
detected rows specifically selects the layout where the colored circle actually aligns with the
printed task title.
