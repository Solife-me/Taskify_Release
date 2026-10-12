// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { markdownFromNoteLines } from "../src/domains/tasks/noteMarkdown";
import { linesFromDom } from "../src/ui/task/NoteRichEditor";

function markdownOf(html: string): string {
  const root = document.createElement("div");
  root.innerHTML = html;
  return markdownFromNoteLines(linesFromDom(root));
}

describe("linesFromDom", () => {
  it("reads line kinds and inline formatting", () => {
    expect(
      markdownOf(
        '<div class="nr-line" data-kind="heading" data-level="2">Plan</div>' +
          '<div class="nr-line" data-kind="paragraph">Buy <strong>milk</strong> and <em>eggs</em> <code>a*b</code></div>' +
          '<div class="nr-line" data-kind="paragraph"><br></div>' +
          '<div class="nr-line" data-kind="checklist" data-depth="1" data-checked="true">Done</div>' +
          '<div class="nr-line" data-kind="numbered" data-number="1">one</div>' +
          '<div class="nr-line" data-kind="numbered" data-number="1">two</div>' +
          '<div class="nr-line" data-kind="paragraph"><a href="https://example.com">site</a></div>',
      ),
    ).toBe("## Plan\nBuy **milk** and *eggs* `a*b`\n\n  - [x] Done\n1. one\n2. two\n[site](https://example.com)");
  });

  it("keeps typed syntax literal", () => {
    expect(markdownOf('<div class="nr-line" data-kind="paragraph">- not a list *really*</div>')).toBe(
      "\\- not a list \\*really\\*",
    );
  });

  it("tolerates loose text, line breaks and nested blocks left by editing", () => {
    expect(
      markdownOf(
        'loose<div class="nr-line" data-kind="bullet">a<br>b</div>' +
          '<div class="nr-line" data-kind="paragraph"><div>inner</div><div><b>bold</b></div></div>',
      ),
    ).toBe("loose\n- a\n- b\ninner\n**bold**");
  });
});
