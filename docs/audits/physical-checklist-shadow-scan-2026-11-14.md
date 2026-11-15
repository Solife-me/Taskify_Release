# Physical checklist shadow scan regression — 2026-11-14

## Reproduction

The supplied 960×1280 checklist photo contains all four Taskify alignment markers and keeps the full page visible. Its lower-right paper region is substantially darker than the rest of the sheet.

At the scanner's 900-pixel analysis width, the old single Otsu threshold merged that shaded paper with the lower-right solid marker. The oversized connected region was discarded. Marker selection then substituted a text component at approximately `(687, 834)` for the real lower-right marker at approximately `(784, 1065)`, producing an invalid projective transform and preventing recognition.

## Resolution

Marker detection now combines the normal Otsu pass with a darker ink-only pass and deduplicates the resulting components before choosing the page quadrilateral. The normal pass retains performance and behavior for even lighting; the darker pass separates black ink from a deeply shaded sheet.

A permanent camera-style regression darkens the lower-right portion of the page enough to swallow the marker under the old threshold. It verifies that the page is recognized and a check mark is read, alongside the existing fill/check/X and wrong-print tests.
