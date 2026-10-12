import { describe, expect, it } from "vitest";
import { htmlToReaderMarkdown } from "../reader";

const filler = "The ruling explained the standard in detail. ".repeat(10);

function page(body: string, title = "Page title"): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

describe("htmlToReaderMarkdown", () => {
  it("keeps the article as Markdown and drops the site around it", () => {
    const reader = htmlToReaderMarkdown(
      page(`<header><nav><a href="/">Home</a><a href="/news">News</a></nav></header>
        <main><article><h1>Ruling on appeal</h1><p>The <strong>court</strong> held for the appellant. ${filler}</p>
        <ul><li>First ground</li><li>Second ground</li></ul></article></main>
        <footer>Copyright and cookie notice</footer>`),
      "https://example.com/news/ruling",
    );

    expect(reader?.title).toBeTruthy();
    expect(reader?.markdown).toContain("Ruling on appeal");
    expect(reader?.markdown).toContain("The **court** held for the appellant.");
    expect(reader?.markdown).toMatch(/^-\s+First ground$/m);
    expect(reader?.markdown).not.toContain("Copyright and cookie notice");
  });

  it("keeps tables as Markdown tables", () => {
    const reader = htmlToReaderMarkdown(
      page(`<article><p>${filler}</p><table><tr><th>Court</th><th>Year</th></tr><tr><td>Chancery</td><td>2026</td></tr></table></article>`),
      "https://example.com/table",
    );
    expect(reader?.markdown).toContain("| Court | Year |");
    expect(reader?.markdown).toContain("| Chancery | 2026 |");
  });

  it("resolves relative links, and drops scripts, images and unsafe links", () => {
    const reader = htmlToReaderMarkdown(
      page(`<article><p>See <a href="../cases/1">the earlier case</a> and <a href="javascript:alert(1)">this</a>. ${filler}</p>
        <img src="https://tracker.example/pixel.png" alt="Courthouse steps"><script>alert("x")</script></article>`),
      "https://example.com/news/today",
    );
    expect(reader?.markdown).toContain("[the earlier case](https://example.com/cases/1)");
    expect(reader?.markdown).not.toContain("javascript:");
    expect(reader?.markdown).toContain("and this.");
    expect(reader?.markdown).toContain("Courthouse steps");
    expect(reader?.markdown).not.toContain("tracker.example");
    expect(reader?.markdown).not.toContain("alert");
  });

  it("returns null for text that is not HTML", () => {
    expect(htmlToReaderMarkdown("Just a plain text file.", "https://example.com/a.txt")).toBeNull();
    expect(htmlToReaderMarkdown("", "https://example.com/")).toBeNull();
  });
});
