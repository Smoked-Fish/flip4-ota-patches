import {
    backup, backupParts, changedPartitions, checkGptFiles, EDL_IDS, folderPlan, imagePlan, readGpt, restore,
    restoreText, startEdl, Stop, usbTransport,
} from "./edl.js";
import { logger } from "./log.js";
import { otaPartitions } from "./sideload.js";

const $ = (id) => document.getElementById(id);
const BUFFER = 16 << 20;
export const windows = /Windows/i.test(navigator.userAgentData?.platform ?? navigator.userAgent);

let edl = null;
let file = null; // { handle, name, written, done }
let folder = null; // { dir, name, items, done: Set, finished }
let getOta = null;
let picked = null; // { what, items, skipped, source }
let busy = false;
let stopping = false;

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(0)} MB`);

const progressIn = (bar, rate) => (done, total, speed) => {
    $(bar).hidden = total === undefined;
    if (!total) {
        $(rate).textContent = "";
        return;
    }
    $(bar).value = done / total;
    if (speed) {
        const left = Math.round((total - done) / speed / 60);
        $(rate).textContent = `${fmt(done)} of ${fmt(total)} · ${(speed / 1e6).toFixed(1)} MB/s · about ${left} min left`;
    }
};

const ui = { ...logger("backup", "bstatus"), progress: progressIn("bprogress", "brate") };
const backupUi = ui;
const rui = { ...logger("restore", "rstatus"), progress: progressIn("rprogress", "rrate") };

function fail(e, ui = backupUi) {
    ui.progress();
    if (e instanceof Stop) ui.log(e.message, "error");
    else if (e?.name === "NotFoundError") ui.log("Nothing was picked.", "error");
    else if (e?.name === "AbortError") ui.log("No file was picked.", "error");
    else if (e?.name === "SecurityError" && /claim|access/i.test(e.message)) {
        ui.log("Windows has another driver on the phone in EDL mode. Switch it to WinUSB with the driver helper: "
            + "see \"the phone in edl mode isn't in the list\" below.", "error");
    } else if (e?.name === "NetworkError" || e?.name === "SecurityError" || e?.name === "InvalidStateError") {
        ui.log(`The browser couldn't open the phone (${e.message}). Close anything else using it `
            + "and see \"the phone in edl mode isn't in the list\" below.", "error");
    } else {
        ui.log(`Something went wrong: ${e?.message ?? e}`, "error");
        console.error(e);
    }
}

const mode = () => document.querySelector("input[name=bmode]:checked")?.value ?? "full";

export function setOtaSource(fn) {
    getOta = fn;
}

function show() {
    const usb = "usb" in navigator;
    const started = mode() === "full" ? file : folder;
    const finished = mode() === "full" ? file?.done : folder?.finished;
    const canSave = mode() === "full" ? "showSaveFilePicker" in window : "showDirectoryPicker" in window;
    $("bconnect").hidden = !usb;
    $("bconnect").disabled = busy;
    $("bmodes").hidden = !edl;
    for (const input of document.querySelectorAll("input[name=bmode]")) input.disabled = busy;
    $("bsave").hidden = !edl || (!!started && !finished);
    $("bsave").disabled = busy || !canSave;
    $("bresume").hidden = !started || finished || busy;
    $("bresume").disabled = !edl;
    $("bstop").hidden = !busy || !started || finished;
    $("breset").hidden = !edl || busy;
    $("bnofs").hidden = canSave;
    $("rconnect").hidden = !usb || !!edl;
    $("rconnect").disabled = busy;
    $("rpicks").hidden = !edl;
    $("rimage").disabled = $("rfolder").disabled = busy;
    $("rfolder").hidden = !("showDirectoryPicker" in window);
    $("rcheck").hidden = !picked;
    $("rwrite").hidden = !picked;
    $("rwrite").disabled = busy || !edl || !$("rconfirm").checked;
    $("rstop").hidden = !busy || !picked;
    $("rreset").hidden = !edl || busy;
}

async function changed() {
    if (!getOta) throw new Stop("The page isn't ready yet.");
    const ota = await getOta();
    const plan = changedPartitions(await readGpt(edl.fh), otaPartitions(ota.data, ota.name));
    return { ota, plan, bytes: plan.items.reduce((n, i) => n + i.sectors, 0) * edl.fh.sectorSize };
}

async function sizes() {
    const s = edl.fh.storage;
    $("bmode-full").textContent = `the whole emmc (${fmt(Number(s.total_blocks) * edl.fh.sectorSize)})`;
    try {
        const { ota, plan, bytes } = await changed();
        $("bmode-changed").textContent = `only what ${ota.name} changes (${fmt(bytes)}, `
            + `${plan.items.length} files${plan.slot ? `, slot ${plan.slot}` : ", both slots"})`;
    } catch (e) {
        $("bmode-changed").textContent = `only what the ota changes (${e.message})`;
    }
}

async function loader() {
    const r = await fetch("loader/flip-4-edl.bin");
    if (!r.ok) throw new Stop(`Couldn't load the EDL programmer (${r.status}).`);
    return new Uint8Array(await r.arrayBuffer());
}

async function reopenUsb() {
    const again = (await navigator.usb.getDevices())
        .find((d) => d.vendorId === EDL_IDS.usbVendorId && d.productId === EDL_IDS.usbProductId);
    if (!again) throw new Stop("the device is gone");
    return usbTransport(again);
}

async function connect(ui) {
    busy = true;
    show();
    try {
        await edl?.link.close();
        edl = null;
        const device = await navigator.usb.requestDevice({
            filters: [{ vendorId: EDL_IDS.usbVendorId, productId: EDL_IDS.usbProductId }],
        });
        const transport = usbTransport(device);
        ui.log("Connecting to the phone in EDL mode…");
        const { link, fh } = await startEdl({ transport, loader: await loader(), ui, reopen: reopenUsb });
        edl = { link, fh };
        const s = fh.storage;
        const size = Number(s.total_blocks) * fh.sectorSize;
        $("bstorage").textContent = `${s.mem_type || "eMMC"} ${s.prod_name || ""}: ${fmt(size)} `
            + `(${s.total_blocks} sectors of ${fh.sectorSize} bytes)`;
        $("bstorage").hidden = false;
        $("rstorage").textContent = $("bstorage").textContent;
        $("rstorage").hidden = false;
        picked = null;
        $("rplan").replaceChildren();
        if (ui !== backupUi) ui.log("Ready. Pick the backup to write back.", "ok");
        else ui.log(file && !file.done
            ? `Ready. Resume to carry on from ${fmt(file.written)}.`
            : "Ready. Pick what to back up and where to save it.", "ok");
        await sizes();
    } catch (e) {
        if (e?.name === "NotFoundError" && windows) {
            ui.log("Nothing was picked. If the list was empty, Windows has no WinUSB driver on the phone in EDL mode: "
                + "download the driver helper above and run it.", "warn");
        } else {
            fail(e, ui);
        }
    } finally {
        busy = false;
        show();
    }
}

function buffered(writable) {
    let buf = new Uint8Array(BUFFER);
    let fill = 0;
    return {
        async write(bytes) {
            let at = 0;
            while (at < bytes.length) {
                const n = Math.min(bytes.length - at, BUFFER - fill);
                buf.set(bytes.subarray(at, at + n), fill);
                fill += n;
                at += n;
                if (fill === BUFFER) await this.flush();
            }
        },
        async flush() {
            if (!fill) return;
            await writable.write(buf.subarray(0, fill));
            buf = new Uint8Array(BUFFER);
            fill = 0;
        },
        async close() {
            try {
                await this.flush();
            } finally {
                await writable.close();
            }
        },
    };
}

async function runParts(resume) {
    const { fh } = edl;
    if (!resume) {
        const { ota, plan, bytes } = await changed();
        const parent = await window.showDirectoryPicker({ id: "flip4-backup", mode: "readwrite" });
        const name = `flip4-partitions-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}`;
        const dir = await parent.getDirectoryHandle(name, { create: true });
        folder = { dir, name, items: plan.items, done: new Set(), finished: false };
        if (plan.missing.length) ui.log(`Not on this phone, so not backed up: ${plan.missing.join(", ")}`, "warn");
        const notes = await (await dir.getFileHandle("RESTORE.txt", { create: true })).createWritable();
        await notes.write(restoreText(ota, plan, fh.sectorSize));
        await notes.close();
        ui.log(`Backing up ${fmt(bytes)} in ${plan.items.length} files to ${name}. Leave the phone plugged in.`);
    } else {
        ui.log(`Resuming: ${folder.done.size} of ${folder.items.length} files are saved.`);
    }
    show();
    const open = async ({ file: path }) => {
        const parts = path.split("/");
        let dir = folder.dir;
        for (const sub of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(sub, { create: true });
        return buffered(await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable());
    };
    await backupParts({ fh, items: folder.items, open, ui, done: folder.done, stopped: () => stopping });
    folder.finished = true;
    ui.log(`Done: ${folder.name}. Keep it somewhere safe: its RESTORE.txt says how to write it back.`, "ok");
}

async function run(resume) {
    if (mode() === "changed") {
        busy = true;
        stopping = false;
        show();
        try {
            await runParts(resume);
        } catch (e) {
            fail(e);
            if (folder && !folder.finished) {
                ui.log(`${folder.done.size} of ${folder.items.length} files are saved. Fix the problem (put the phone back `
                    + "in EDL mode if it left it), connect again and press resume.", "warn");
            }
        } finally {
            busy = false;
            show();
        }
        return;
    }
    busy = true;
    stopping = false;
    show();
    let writable = null;
    try {
        if (!resume) {
            const handle = await window.showSaveFilePicker({
                suggestedName: "flip4-full-emmc.img",
                types: [{ description: "Disk image", accept: { "application/octet-stream": [".img"] } }],
            });
            file = { handle, name: handle.name, written: 0, done: false };
            writable = await handle.createWritable();
        } else {
            file.written -= file.written % edl.fh.sectorSize;
            writable = await file.handle.createWritable({ keepExistingData: true });
            await writable.truncate(file.written);
            await writable.seek(file.written);
        }
        show();
        const { fh } = edl;
        const from = file.written / fh.sectorSize;
        ui.log(resume ? `Resuming at ${fmt(file.written)}…` : `Backing up to ${file.name}. Leave the phone plugged in.`);

        let buf = new Uint8Array(BUFFER);
        let fill = 0;
        const flush = async () => {
            if (!fill) return;
            await writable.write(buf.subarray(0, fill));
            file.written += fill;
            buf = new Uint8Array(BUFFER);
            fill = 0;
        };
        const sink = async (bytes) => {
            let at = 0;
            while (at < bytes.length) {
                const n = Math.min(bytes.length - at, BUFFER - fill);
                buf.set(bytes.subarray(at, at + n), fill);
                fill += n;
                at += n;
                if (fill === BUFFER) await flush();
            }
        };
        if (from === 0) {
            const first = [];
            await fh.read(0, 34, (b) => first.push(b.slice()));
            const head = new Uint8Array(first.reduce((n, b) => n + b.length, 0));
            first.reduce((at, b) => (head.set(b, at), at + b.length), 0);
            if (new TextDecoder().decode(head.subarray(fh.sectorSize, fh.sectorSize + 8)) !== "EFI PART") {
                throw new Stop("The start of the storage isn't a GPT. Not backing up something that doesn't look like this phone.");
            }
        }
        try {
            await backup({ fh, sink, ui, from, stopped: () => stopping });
            await flush();
            file.done = true;
        } finally {
            await flush().catch(() => {});
        }
        ui.log(`Done: ${file.name}, ${fmt(file.written)}. Keep it somewhere safe: the restore box writes it back.`, "ok");
    } catch (e) {
        fail(e);
        if (file && !file.done && file.written) {
            ui.log(`${fmt(file.written)} are saved. Fix the problem (put the phone back in EDL mode if it left it), `
                + "connect again and press resume.", "warn");
        }
    } finally {
        await writable?.close().catch(() => {});
        busy = false;
        show();
    }
}

async function reset(ui = backupUi) {
    busy = true;
    show();
    try {
        ui.log("Restarting the phone…");
        const r = await edl.fh.reset();
        ui.log(r?.gone
            ? "The phone is restarting. It's back in about 30 seconds."
            : "The phone didn't restart: hold Power until it does.", r?.gone ? "ok" : "warn");
    } finally {
        await edl.link.close();
        edl = null;
        busy = false;
        $("bstorage").hidden = true;
        $("rstorage").hidden = true;
        show();
    }
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

function showPlan() {
    const rows = picked.items.map((i) => `${i.name.padEnd(28)} ${fmt(i.sectors * edl.fh.sectorSize).padStart(9)}`);
    const total = picked.items.reduce((n, i) => n + i.sectors, 0) * edl.fh.sectorSize;
    const pre = document.createElement("pre");
    pre.textContent = rows.join("\n");
    const head = document.createElement("p");
    head.className = "release";
    head.textContent = `${picked.what}: ${picked.items.length} parts, ${fmt(total)}, the partition table last`;
    $("rplan").replaceChildren(head, pre);
    for (const s of picked.skipped) rui.log(`Skipped ${s}`, "warn");
}

async function pickImage(file) {
    const { fh } = edl;
    const gpt = await readGpt(fh);
    const items = imagePlan(gpt, await bytesOf(file.slice(0, gpt.sectors * fh.sectorSize)), file.size, fh.sectorSize,
        Number(fh.storage.total_blocks));
    checkGptFiles(await bytesOf(file.slice(0, gpt.sectors * fh.sectorSize)),
        await bytesOf(file.slice(gpt.backupEntriesLba * fh.sectorSize, (gpt.backupLba + 1) * fh.sectorSize)), fh.sectorSize);
    return { what: file.name, items, skipped: [], source: (item, offset, length) => bytesOf(file.slice(offset, offset + length)) };
}

async function pickFolder(dir) {
    const { fh } = edl;
    const files = new Map();
    for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "file") files.set(name, await handle.getFile());
        else if (name === "gpt") {
            for await (const [n, h] of handle.entries()) if (h.kind === "file") files.set(`gpt/${n}`, await h.getFile());
        }
    }
    const gpt = await readGpt(fh);
    const main = files.has("gpt/gpt_main0.bin") ? await bytesOf(files.get("gpt/gpt_main0.bin")) : null;
    const list = [...files].map(([path, f]) => ({ path, size: f.size })).sort((a, b) => a.path.localeCompare(b.path));
    const { items, skipped } = folderPlan(gpt, list, main, fh.sectorSize);
    checkGptFiles(main, files.has("gpt/gpt_backup0.bin") && items.some((i) => i.path === "gpt/gpt_backup0.bin")
        ? await bytesOf(files.get("gpt/gpt_backup0.bin")) : null, fh.sectorSize);
    return { what: dir.name, items, skipped, source: (item, offset, length) => bytesOf(files.get(item.path).slice(offset, offset + length)) };
}

async function pick(how) {
    busy = true;
    show();
    try {
        picked = null;
        $("rplan").replaceChildren();
        $("rconfirm").checked = false;
        if (how === "folder") {
            picked = await pickFolder(await window.showDirectoryPicker({ id: "flip4-backup", mode: "read" }));
        } else {
            const file = $("rimagefile").files[0];
            $("rimagefile").value = "";
            if (!file) return;
            rui.log(`Checking ${file.name} against this phone…`);
            picked = await pickImage(file);
        }
        showPlan();
        rui.log(`${picked.what} matches this phone. Tick the box to write it.`, "ok");
    } catch (e) {
        picked = null;
        fail(e, rui);
    } finally {
        busy = false;
        show();
    }
}

async function write() {
    busy = true;
    stopping = false;
    show();
    try {
        const verify = $("rverify").checked;
        rui.log(`Writing ${picked.what} to the phone. Leave it plugged in.`);
        await restore({ fh: edl.fh, items: picked.items, source: picked.source, ui: rui, verify, stopped: () => stopping });
        rui.log(`Done: ${picked.what} is back on the phone${verify ? " and checked" : ""}. Restart it to boot.`, "ok");
        picked = null;
        $("rplan").replaceChildren();
    } catch (e) {
        fail(e, rui);
        rui.log("The phone may be half written. Don't restart it: fix the problem and write the backup again "
            + "(put the phone back in EDL mode and connect first if it left it).", "warn");
    } finally {
        $("rconfirm").checked = false;
        busy = false;
        show();
    }
}

$("bconnect").addEventListener("click", () => connect(backupUi));
$("bsave").addEventListener("click", () => run(false));
$("bresume").addEventListener("click", () => run(true));
$("bstop").addEventListener("click", () => { stopping = true; });
for (const input of document.querySelectorAll("input[name=bmode]")) input.addEventListener("change", show);
$("breset").addEventListener("click", () => reset(backupUi));
$("rconnect").addEventListener("click", () => connect(rui));
$("rimage").addEventListener("click", () => $("rimagefile").click());
$("rimagefile").addEventListener("change", () => pick("image"));
$("rfolder").addEventListener("click", () => pick("folder"));
$("rconfirm").addEventListener("change", show);
$("rwrite").addEventListener("click", write);
$("rstop").addEventListener("click", () => { stopping = true; });
$("rreset").addEventListener("click", () => reset(rui));
show();
