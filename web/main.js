import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { setOtaSource, windows } from "./backup.js";
import { logger } from "./log.js";
import {
    connect, findSideload, inSideload, phoneInfo, readOta, rebootToSideload, sideload, Stop,
} from "./sideload.js";

const $ = (id) => document.getElementById(id);
const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
const credentials = new AdbWebCredentialStore("Flip 4 OTA");

const FLIPFULL = { text: "Flipfull", href: "https://github.com/Smoked-Fish/Flipfull" };
const ABOUT = {
    "ota-debug-permissive-userinit.zip": ["root and the userinit boot hook (for ", FLIPFULL, ")"],
    "ota-debug-permissive.zip": ["root without the userinit boot hook"],
    "ota_stock.zip": ["puts the system partition back to stock"], // todo
};

function aboutNodes(parts) {
    return parts.map((part) => {
        if (typeof part === "string") return part;
        const a = document.createElement("a");
        a.textContent = part.text;
        a.href = part.href;
        a.target = "_blank";
        a.rel = "noopener";
        return a;
    });
}

let releases = []; // [{ tag, otas: [{ name, size }] }], newest first
let releasesLoaded = false;
let release = null;
let ota = null; // { name, data, meta } once read, { name, url, size } before
let phone = null; // { adb, device, info, sideload }
let busy = false;
let waiting = false;
let sending = false;

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectWhenReady(device) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await connect(device, credentials);
        } catch (e) {
            if (!(e instanceof TypeError) || attempt === 5) throw e;
            await sleep(500);
            device = (await manager.getDevices()).find((d) => d.serial === device.serial) ?? device;
        }
    }
}
const releaseFor = (build) => releases.find((r) => r.tag === build) ?? null;
const otaFrom = (r, o) => ({ name: o.name, url: `${r.tag}/${o.name}`, size: o.size });

const ui = {
    ...logger("flash", "fstatus"),
    progress(done, total) {
        $("progress").hidden = total === undefined;
        if (total) $("progress").value = done / total;
    },
};

function fail(e) {
    ui.progress();
    if (e instanceof Stop) {
        ui.log(e.message, "error");
    } else if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
        ui.log("Another program has the phone's adb connection, usually adb on this computer. "
            + "Run \"adb kill-server\" (or close the program) and try again.", "error");
    } else if (e?.name === "NotFoundError") {
        ui.log("No phone was picked.", "error");
    } else if (e?.name === "SecurityError" || e?.name === "NetworkError") {
        ui.log(`The browser couldn't open the phone (${e.message}). See "the phone isn't in the list" below.`, "error");
    } else {
        ui.log(`Something went wrong: ${e?.message ?? e}`, "error");
        console.error(e);
    }
}

function show() {
    const supported = phone?.sideload || !!releaseFor(phone?.info?.build);
    const working = busy || sending;
    $("connect").disabled = working || !manager;
    $("pick").hidden = !phone || !supported;
    $("chosen").hidden = !phone || !supported;
    $("flash").hidden = !phone || !$("repick").hidden;
    $("flash").textContent = phone?.sideload ? "flash" : "reboot to sideload and flash";
    $("flash").disabled = working || !supported || !ota || !$("backed-up").checked;
    $("ack").hidden = !phone || !supported;
    $("chosen").textContent = ota?.data
        ? `${ota.name}: ${ota.meta["post-build-incremental"]}, ${mb(ota.data.length)}`
        : ota ? `${ota.name} (${mb(ota.size)}), downloaded when you flash` : "no ota picked";
}

function listOtas() {
    $("otas").replaceChildren(...(release?.otas ?? []).map((o, i) => {
        const label = document.createElement("label");
        label.className = "check";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "ota";
        input.checked = i === 0;
        input.addEventListener("change", () => {
            ota = otaFrom(release, o);
            show();
        });
        label.append(input, ` ${o.name}`);
        if (ABOUT[o.name]) label.append(" · ", ...aboutNodes(ABOUT[o.name]));
        return label;
    }));
}

function showRelease() {
    const build = phone?.info?.build;
    release = phone?.sideload ? releases[0] ?? null : releaseFor(build);
    if (!releasesLoaded) {
        $("release").textContent = "Couldn't load the list of OTAs, so the build can't be checked. Reload the page to try again.";
    } else if (release) {
        $("release").textContent = phone.sideload
            ? `otas for ${release.tag} (the build can't be checked in sideload mode)`
            : `otas for ${release.tag}`;
    } else {
        $("release").textContent = `No OTA for build ${build || "unknown"} yet. `
            + `Supported: ${releases.map((r) => r.tag).join(", ") || "none"}.`;
    }
    listOtas();
    ota = release?.otas.length ? otaFrom(release, release.otas[0]) : null;
    show();
}

async function loadReleases() {
    try {
        const r = await fetch("releases.json", { cache: "no-cache" });
        if (!r.ok) throw new Error(r.status);
        releases = (await r.json()).filter((x) => x.otas.length)
            .map((x) => ({ ...x, otas: x.otas.sort((a, b) => Object.keys(ABOUT).indexOf(a.name) - Object.keys(ABOUT).indexOf(b.name)) }));
        releasesLoaded = true;
    } catch {
        releasesLoaded = false;
    }
    if (!ota && releases[0]) ota = otaFrom(releases[0], releases[0].otas[0]);
    if (phone) showRelease();
}

async function useLocalZip(file) {
    try {
        const data = new Uint8Array(await file.arrayBuffer());
        ota = { name: file.name, data, meta: readOta(data, file.name) };
        for (const input of document.querySelectorAll("input[name=ota]")) input.checked = false;
    } catch (e) {
        fail(e);
    }
    show();
}

async function download({ url, size }) {
    const r = await fetch(url);
    if (!r.ok) throw new Stop(`couldn't download ${url}: ${r.status}`);
    const total = Number(r.headers.get("content-length")) || size;
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        ui.progress(got, total);
    }
    const bytes = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
        bytes.set(p, at);
        at += p.length;
    }
    ui.progress();
    return bytes;
}

async function readChosenOta() {
    if (!ota.data) {
        const data = await download(ota);
        ota = { name: ota.name, data, meta: readOta(data, ota.name) };
        show();
    }
    return ota;
}

function showPhone() {
    const supported = !!releaseFor(phone.info?.build);
    const rows = phone.sideload
        ? [["mode", "sideload: waiting for a package. The build can't be checked in this mode."]]
        : [
            ["model", phone.info.model],
            ["build", `${phone.info.build || "unknown"} ${supported ? "(supported)" : "(not supported)"}`],
            ["slot", `${phone.info.slot.replace("_", "")} (the ota goes on the other one)`],
        ];
    $("phone").replaceChildren(...rows.flatMap(([k, v]) => {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        return [dt, dd];
    }));
    $("phone").hidden = false;
}

async function connectPhone() {
    busy = true;
    show();
    try {
        await phone?.adb.close().catch(() => {});
        phone = null;
        const device = await manager.requestDevice();
        if (!device) throw new Stop("No phone was picked.");
        ui.log("Connecting. If the phone asks to allow USB debugging, allow it…");
        const adb = await connectWhenReady(device);
        phone = { adb, device, sideload: inSideload(adb) };
        if (phone.sideload) {
            ui.log("Connected to the phone in sideload mode.");
        } else {
            phone.info = await phoneInfo(adb);
            if (!/T440/i.test(phone.info.model)) {
                ui.log(`This is a ${phone.info.model}, not a TCL Flip 4 (T440W).`, "error");
            } else if (!releaseFor(phone.info.build)) {
                ui.log(`The phone is on build ${phone.info.build || "unknown"}, which has no OTA here: `
                    + "flashing one made for another build can brick the phone.", "error");
            } else {
                ui.log(`Connected: ${phone.info.model} on ${phone.info.build}.`);
            }
        }
        showPhone();
        showRelease();
    } catch (e) {
        fail(e);
    } finally {
        busy = false;
        show();
    }
}

async function flash() {
    busy = true;
    show();
    try {
        if (!ota.data) ui.log(`Downloading ${ota.name}…`);
        await readChosenOta();
        if (!phone.sideload) {
            if (phone.info.incremental === ota.meta["post-build-incremental"]) {
                ui.log("This phone already runs the build this OTA makes. Flashing it will result in an error (I think).", "warn");
            }
            ui.log("Rebooting into sideload mode…");
            await rebootToSideload(phone.adb);
            ui.log("When the phone says it's waiting for a package, press \"pick the phone in sideload mode\". "
                + "In this mode the list calls it T440W.");
            phone = { device: null, sideload: true, adb: null };
            $("repick").hidden = false;
            waiting = true;
            const adb = await findSideload(manager, credentials, { log() {} }, 120, () => !waiting);
            if (!adb || !waiting) return;
            waiting = false;
            phone = { adb, sideload: true };
            $("repick").hidden = true;
        }
        await send();
    } catch (e) {
        fail(e);
    } finally {
        busy = false;
        show();
    }
}

async function repick() {
    waiting = false;
    busy = true;
    show();
    try {
        const device = await manager.requestDevice();
        if (!device) throw new Stop("No phone was picked.");
        const adb = await connectWhenReady(device);
        if (!inSideload(adb)) {
            await adb.close().catch(() => {});
            throw new Stop("That's the phone, but it isn't in sideload mode. Its screen should say it's waiting for a package.");
        }
        phone = { adb, device, sideload: true };
        $("repick").hidden = true;
        await send();
    } catch (e) {
        fail(e);
    } finally {
        busy = false;
        show();
    }
}

async function send() {
    sending = true;
    show();
    try {
        ui.log(`Sending ${ota.name}. The phone installs it as it reads it, so don't unplug it.`);
        await sideload(phone.adb, ota.data, ui);
        ui.progress();
        ui.log("Done.", "ok");
        $("done").hidden = false;
        await phone.adb.close().catch(() => {});
        phone = null;
        $("flash").hidden = true;
    } finally {
        sending = false;
        show();
    }
}

if (!manager) $("nousb").hidden = false;
for (const hint of document.querySelectorAll(".windows")) hint.hidden = !windows;
$("connect").addEventListener("click", connectPhone);
$("flash").addEventListener("click", flash);
$("repick").addEventListener("click", repick);
$("backed-up").addEventListener("change", show);
$("pick").addEventListener("click", () => $("zip").click());
$("zip").addEventListener("change", (e) => e.target.files[0] && useLocalZip(e.target.files[0]));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && !busy && phone) useLocalZip(file);
});
setOtaSource(async () => {
    if (!ota) throw new Stop("no ota to compare against yet");
    return readChosenOta();
});
show();
loadReleases();
