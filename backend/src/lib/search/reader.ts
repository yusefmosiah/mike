import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";

// linkedom's declarations are ES-module only; its CommonJS build is what
// loads here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseHTML } = require("linkedom") as { parseHTML(html: string): { document: Document } };

/** A fetched page reduced to its main content, as Markdown. */
export type ReaderPage = { title: string | null; markdown: string };

// Pages larger than this are not converted; the plain text still is.
const MAX_HTML_BYTES = 5_000_000;
const MAX_MARKDOWN_CHARS = 500_000;

function turndown(baseUrl: string): TurndownService {
    const service = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
        emDelimiter: "*",
    });
    service.use(gfm);
    // Images would load from the source site when the reader opens; keep
    // their alt text only.
    service.addRule("imageAlt", {
        filter: "img",
        replacement: (_content, node) => {
            const alt = (node as { getAttribute(name: string): string | null }).getAttribute("alt")?.trim();
            return alt ? alt : "";
        },
    });
    service.remove(["script", "style", "noscript", "iframe", "form", "button", "video", "audio", "canvas"]);
    // Links resolve against the page and keep only http(s) and mailto.
    service.addRule("absoluteLinks", {
        filter: "a",
        replacement: (content, node) => {
            const text = content.trim();
            const href = (node as { getAttribute(name: string): string | null }).getAttribute("href");
            if (!text) return "";
            if (!href) return text;
            let resolved: URL;
            try {
                resolved = new URL(href, baseUrl);
            } catch {
                return text;
            }
            if (!["http:", "https:", "mailto:"].includes(resolved.protocol)) return text;
            return `[${text}](${resolved.toString().replace(/[()]/g, (c) => encodeURIComponent(c))})`;
        },
    });
    return service;
}

/**
 * Extract a page's article, Readability-style, and convert it to Markdown for
 * the reader view. Returns null when the input is not HTML or no article can
 * be found; callers fall back to the plain text.
 */
export function htmlToReaderMarkdown(html: string, url: string): ReaderPage | null {
    if (!html || html.length > MAX_HTML_BYTES || !/<[a-z!][\s\S]*>/i.test(html)) return null;
    try {
        const { document } = parseHTML(html);
        const pageTitle = document.querySelector("title")?.textContent?.trim() || null;
        const article = new Readability(document, { charThreshold: 200 }).parse();
        if (!article?.content) return null;
        const markdown = turndown(url)
            .turndown(article.content)
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        if (!markdown) return null;
        return {
            title: article.title?.trim() || pageTitle,
            markdown: markdown.slice(0, MAX_MARKDOWN_CHARS),
        };
    } catch {
        return null;
    }
}
