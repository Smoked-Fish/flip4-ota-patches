import { build } from "esbuild";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const out = resolve(process.argv[2] ?? join(here, "dist/site"));
mkdirSync(out, { recursive: true });

await build({
    entryPoints: [join(here, "main.js")],
    outfile: join(out, "app.js"),
    bundle: true,
    format: "esm",
    minify: true,
    target: ["chrome100", "edge100"],
    legalComments: "none",
    logLevel: "warning",
});
copyFileSync(join(here, "style.css"), join(out, "style.css"));
const stamp = (file) => createHash("sha256").update(readFileSync(join(out, file))).digest("hex").slice(0, 10);
writeFileSync(join(out, "index.html"), readFileSync(join(here, "index.html"), "utf8")
    .replace('href="style.css"', `href="style.css?v=${stamp("style.css")}"`)
    .replace('src="app.js"', `src="app.js?v=${stamp("app.js")}"`));
mkdirSync(join(out, "loader"), { recursive: true });
copyFileSync(join(here, "../loader/flip-4-edl.bin"), join(out, "loader", "flip-4-edl.bin"));
mkdirSync(join(out, "fonts"), { recursive: true });
for (const weight of [300, 400, 500]) {
    copyFileSync(join(here, `node_modules/@fontsource/dm-mono/files/dm-mono-latin-${weight}-normal.woff2`),
        join(out, "fonts", `dm-mono-${weight}.woff2`));
}
copyFileSync(join(here, "node_modules/@fontsource/dm-mono/LICENSE"), join(out, "fonts", "LICENSE"));
const crlf = (file) => new TextEncoder().encode(readFileSync(join(here, "driver", file), "utf8").replace(/\r?\n/g, "\r\n"));
writeFileSync(join(out, "flip4-edl-driver.zip"), zipSync({
    "flip4-edl-driver/install-edl-driver.bat": crlf("install-edl-driver.bat"),
    "flip4-edl-driver/README.txt": crlf("README.txt"),
    "flip4-edl-driver/wdi-simple.exe": readFileSync(join(here, "../tools/wdi-simple.exe")),
}, { level: 9 }));
console.log(`ota page -> ${out}`);
