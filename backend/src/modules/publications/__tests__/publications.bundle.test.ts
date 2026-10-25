import { describe, expect, it } from "vitest";
import { relativeReferences, withEmbedReferrers } from "../publications.bundle";

describe("relativeReferences", () => {
    it("finds the files a page refers to and leaves the web alone", () => {
        const html = `
            <img src="images/a.png"><img src="./b%20c.jpg?v=2#x">
            <audio src="/media/talk.mp3"></audio><video src="clip.mp4" poster="poster.jpg"></video>
            <source src="alt.webm"><track src="subs.vtt"><link href="style.css"><script src="app.js"></script>
            <a href="page2.html#top">next</a>
            <a href="https://example.com">web</a><a href="mailto:a@b.c">mail</a><a href="#section">jump</a>
            <img src="//cdn.example.com/x.png"><img src="data:image/png;base64,AAAA"><img src="">
            <img src="../outside.png"><img src="images/../c.png">`;
        expect(relativeReferences(html).sort()).toEqual(
            [
                "images/a.png",
                "b c.jpg",
                "media/talk.mp3",
                "clip.mp4",
                "poster.jpg",
                "alt.webm",
                "subs.vtt",
                "style.css",
                "app.js",
                "page2.html",
                "c.png",
            ].sort(),
        );
    });

    it("resolves against the page's own folder", () => {
        expect(relativeReferences('<img src="a.png"><img src="../b.png"><img src="/c.png">', "guide/intro.html").sort()).toEqual(
            ["b.png", "c.png", "guide/a.png"],
        );
    });
});

describe("withEmbedReferrers", () => {
    it("lets YouTube embeds send the page's origin unless the author chose", () => {
        expect(withEmbedReferrers('<iframe src="https://www.youtube.com/embed/x"></iframe>')).toBe(
            '<iframe referrerpolicy="strict-origin-when-cross-origin" src="https://www.youtube.com/embed/x"></iframe>',
        );
        const chosen = '<IFRAME referrerpolicy="origin" src="https://www.youtube-nocookie.com/embed/x">';
        expect(withEmbedReferrers(chosen)).toBe(chosen);
        const vimeo = '<iframe src="https://player.vimeo.com/video/1">';
        expect(withEmbedReferrers(vimeo)).toBe(vimeo);
    });
});
