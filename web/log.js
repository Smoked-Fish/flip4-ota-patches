const MAX = 400;
const $ = (id) => document.getElementById(id);

let lines = 0;

function dock() {
    $("dock").hidden = false;
    document.body.classList.add("docked");
}

const time = () => new Date().toTimeString().slice(0, 8);

export function logger(source, status) {
    return {
        log(text, kind) {
            (kind === "error" ? console.error : kind === "warn" ? console.warn : console.log)(`[${source}] ${text}`);
            const s = $(status);
            if (s) {
                s.textContent = text;
                s.className = `status ${kind || ""}`;
                s.hidden = false;
            }
            const box = $("dock-lines");
            const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
            const line = document.createElement("div");
            if (kind) line.className = kind;
            const meta = document.createElement("span");
            meta.className = "meta";
            meta.textContent = `${time()} ${source.padEnd(7)} `;
            line.append(meta, text);
            box.append(line);
            if (++lines > MAX) {
                box.firstElementChild.remove();
                lines--;
            }
            $("dock-count").textContent = `${lines} line${lines === 1 ? "" : "s"}`;
            if (stick) box.scrollTop = box.scrollHeight;
            dock();
        },
    };
}

$("dock-size").addEventListener("click", () => {
    const big = $("dock").classList.toggle("big");
    $("dock-size").textContent = big ? "smaller" : "bigger";
    $("dock-lines").scrollTop = $("dock-lines").scrollHeight;
});
$("dock-copy").addEventListener("click", async () => {
    const text = [...$("dock-lines").children].map((l) => l.textContent).join("\n");
    try {
        await navigator.clipboard.writeText(text);
        $("dock-copy").textContent = "copied";
    } catch {
        $("dock-copy").textContent = "can't copy";
    }
    setTimeout(() => { $("dock-copy").textContent = "copy"; }, 1500);
});
$("dock-clear").addEventListener("click", () => {
    $("dock-lines").replaceChildren();
    lines = 0;
    $("dock-count").textContent = "";
});
$("dock-hide").addEventListener("click", () => {
    $("dock").hidden = true;
    document.body.classList.remove("docked");
});
