import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { unzipSync } from "fflate";

const DEVICE = "pitti_32go";
const BLOCK = 65536;
const METADATA = "META-INF/com/android/metadata";

export class Stop extends Error {}

export function readOta(bytes, name) {
    let files;
    try {
        files = unzipSync(bytes, { filter: (f) => f.name === METADATA || f.name === "payload.bin" });
    } catch {
        throw new Stop(`${name} isn't a zip file`);
    }
    const text = files[METADATA];
    if (!text || !files["payload.bin"]) throw new Stop(`${name} isn't an OTA (no metadata or payload.bin in it)`);
    const meta = Object.fromEntries(new TextDecoder().decode(text).split("\n")
        .filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    if (meta["ota-type"] !== "AB") throw new Stop(`${name} isn't an A/B OTA`);
    if (meta["pre-device"] !== DEVICE) {
        throw new Stop(`${name} is for ${meta["pre-device"] || "another phone"}, not the TCL Flip 4 (${DEVICE})`);
    }
    return meta;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANIFEST_PARTITIONS = 13;
const MANIFEST_DYNAMIC = 15;

export function otaPartitions(bytes, name) {
    const p = unzipSync(bytes, { filter: (f) => f.name === "payload.bin" })["payload.bin"];
    if (!p || new TextDecoder().decode(p.subarray(0, 4)) !== "CrAU") throw new Stop(`${name} has no payload.bin`);
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (view.getBigUint64(4) !== 2n) throw new Stop(`${name} has a payload.bin this phone doesn't take`);
    const manifest = p.subarray(24, 24 + Number(view.getBigUint64(12)));
    const all = [];
    const logical = new Set();
    for (const [field, value] of protoFields(manifest)) {
        if (field === MANIFEST_PARTITIONS) {
            for (const [f, v] of protoFields(value)) if (f === 1) all.push(new TextDecoder().decode(v));
        } else if (field === MANIFEST_DYNAMIC) {
            for (const [f, v] of protoFields(value)) {
                if (f === 1) for (const [g, w] of protoFields(v)) if (g === 3) logical.add(new TextDecoder().decode(w));
            }
        }
    }
    return { physical: all.filter((n) => !logical.has(n)), logical: all.filter((n) => logical.has(n)) };
}

function* protoFields(b) {
    let i = 0;
    const varint = () => {
        let n = 0;
        let scale = 1;
        for (;;) {
            const x = b[i++];
            n += (x & 0x7f) * scale;
            scale *= 128;
            if (x < 0x80) return n;
        }
    };
    while (i < b.length) {
        const key = varint();
        const type = key % 8;
        const field = Math.floor(key / 8);
        if (type === 0) yield [field, varint()];
        else if (type === 2) {
            const n = varint();
            yield [field, b.subarray(i, i + n)];
            i += n;
        } else if (type === 1) i += 8;
        else if (type === 5) i += 4;
        else throw new Stop("The OTA's payload manifest is damaged.");
    }
}

export async function connect(device, credentials) {
    const connection = await device.connect();
    return new Adb(await AdbDaemonTransport.authenticate({
        serial: device.serial, connection, credentialStore: credentials,
    }));
}

// How the flip 4 displays its build number
export function buildNumber(systemVersion, vendorVersion = "", productVersion = "") {
    if (!systemVersion) return "";
    if (vendorVersion) {
        const noPerso = systemVersion.substring(1, 4) === vendorVersion.substring(1, 4)
            && vendorVersion.substring(7, 8) !== "0";
        return noPerso
            ? vendorVersion.substring(1, 5) + vendorVersion.substring(4, 8)
            : systemVersion.substring(1, 4) + systemVersion.substring(6, 7) + systemVersion.substring(4, 8);
    }
    const main = systemVersion.substring(1, 4) + systemVersion.substring(6, 7);
    const perso = systemVersion.substring(4, 8);
    if (productVersion && perso === productVersion.substring(4, 8)) {
        return `${main}-${systemVersion.substring(7, 8)}`;
    }
    return main + perso;
}

// Check if `build` is an older version of any release tag with the same carrier prefix
export function newerReleaseFor(build, releases) {
    if (!build || build.length < 6) return null;
    const prefix = build.slice(0, 4);
    const carrier = build.slice(4, 6);
    return releases.find((r) => r.tag.length >= 6
        && r.tag.slice(4, 6) === carrier
        && r.tag.slice(0, 4) > prefix) ?? null;
}

export async function phoneInfo(adb) {
    const prop = async (key) => (await adb.getProp(key)).trim();
    const system = await prop("ro.tct.ver.system");
    const vendor = await prop("ro.vendor.tct.ver.vendor");
    const product = await prop("ro.tct.ver.product");
    return {
        build: buildNumber(system, vendor, product),
        model: await prop("ro.product.model"),
        slot: await prop("ro.boot.slot_suffix"),
        incremental: await prop("ro.build.version.incremental"),
    };
}

export async function rebootToSideload(adb) {
    await adb.power.reboot("sideload").catch(() => {});
    await adb.close().catch(() => {});
}

export async function findSideload(manager, credentials, ui, seconds = 90, stopped = () => false) {
    for (let i = 0; i < seconds && !stopped(); i++) {
        for (const device of await manager.getDevices()) {
            if (stopped()) return null;
            const adb = await connect(device, credentials).catch(() => null);
            if (!adb) continue;
            if (inSideload(adb)) return adb;
            await adb.close().catch(() => {});
        }
        if (i === 10) ui.log("Still waiting. The phone's screen should say it's waiting for a package.");
        await sleep(1000);
    }
    return null;
}

export const inSideload = (adb) => adb.banner.state === "sideload";

// https://github.com/yume-chan/ya-webadb/issues/368
export async function sideload(adb, data, ui) {
    const socket = await adb.createSocket(`sideload-host:${data.length}:${BLOCK}`);
    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();
    const decoder = new TextDecoder();
    const blocks = Math.ceil(data.length / BLOCK);
    const sent = new Set();
    let pending = "";
    try {
        for (;;) {
            while (pending.length < 8) {
                const { done, value } = await reader.read();
                if (done) throw new Stop("The phone closed the connection before it finished the update.");
                pending += decoder.decode(value, { stream: true });
            }
            const ask = pending.slice(0, 8);
            pending = pending.slice(8);
            if (ask === "DONEDONE") return;
            if (ask === "FAILFAIL") throw new Stop("The phone refused the update. Its screen says why.");
            const block = Number.parseInt(ask, 10);
            if (!Number.isInteger(block) || block < 0 || block >= blocks) {
                throw new Stop(`The phone asked for something odd (${JSON.stringify(ask)}).`);
            }
            await writer.write(data.subarray(block * BLOCK, Math.min((block + 1) * BLOCK, data.length)));
            sent.add(block);
            ui.progress(sent.size, blocks);
        }
    } finally {
        reader.releaseLock();
        writer.releaseLock();
        await socket.close().catch(() => {});
    }
}
