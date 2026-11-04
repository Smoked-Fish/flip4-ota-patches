// node banner.mjs ["TEXT"]
import figlet from "figlet";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CELL_W = 10;
const CELL_H = 20;
const GAP = 2.6;
const cx = CELL_W / 2;
const cy = CELL_H / 2;

const SHADOW = {
    "═": [[[0, cy - GAP], [CELL_W, cy - GAP]], [[0, cy + GAP], [CELL_W, cy + GAP]]],
    "║": [[[cx - GAP, 0], [cx - GAP, CELL_H]], [[cx + GAP, 0], [cx + GAP, CELL_H]]],
    "╗": [[[0, cy - GAP], [cx + GAP, cy - GAP], [cx + GAP, CELL_H]], [[0, cy + GAP], [cx - GAP, cy + GAP], [cx - GAP, CELL_H]]],
    "╔": [[[CELL_W, cy - GAP], [cx - GAP, cy - GAP], [cx - GAP, CELL_H]], [[CELL_W, cy + GAP], [cx + GAP, cy + GAP], [cx + GAP, CELL_H]]],
    "╝": [[[0, cy + GAP], [cx + GAP, cy + GAP], [cx + GAP, 0]], [[0, cy - GAP], [cx - GAP, cy - GAP], [cx - GAP, 0]]],
    "╚": [[[CELL_W, cy + GAP], [cx - GAP, cy + GAP], [cx - GAP, 0]], [[CELL_W, cy - GAP], [cx + GAP, cy - GAP], [cx + GAP, 0]]],
};

const num = (n) => String(Math.round(n * 100) / 100);
const escape = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function bannerSvg(text) {
    const rows = figlet.textSync(text, { font: "ANSI Shadow" }).split("\n").map((r) => r.trimEnd()).filter(Boolean);
    const cols = Math.max(...rows.map((r) => r.length));
    const rects = [];
    const paths = [];
    rows.forEach((row, r) => {
        const y = r * CELL_H;
        for (const m of row.matchAll(/█+/g)) {
            rects.push(`<rect x="${m.index * CELL_W}" y="${num(y - 0.3)}" width="${m[0].length * CELL_W}" height="${CELL_H + 0.6}"/>`);
        }
        [...row].forEach((ch, c) => {
            for (const line of SHADOW[ch] ?? []) {
                paths.push(`M${line.map(([px, py]) => `${num(c * CELL_W + px)} ${num(y + py)}`).join(" L")}`);
            }
        });
    });
    return `<svg class="banner" viewBox="0 -1 ${cols * CELL_W} ${rows.length * CELL_H + 2}" role="img" `
        + `aria-label="${escape(text)}"><g fill="currentColor">${rects.join("")}</g>`
        + `<path d="${paths.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.6"/></svg>`;
}

const text = process.argv[2] ?? "flip4 ota";
const page = join(import.meta.dirname, "index.html");
const html = readFileSync(page, "utf8");
const banner = /<svg class="banner"[\s\S]*?<\/svg>/;
if (!banner.test(html)) throw new Error("index.html has no <svg class=\"banner\"> to replace");
writeFileSync(page, html.replace(banner, () => bannerSvg(text)));
console.log(`banner: "${text}" -> ${page}`);
