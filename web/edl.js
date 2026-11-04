export class Stop extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const EDL_IDS = { usbVendorId: 0x05c6, usbProductId: 0x9008 };

export const edl = { trace: null };
const hex = (b) => Array.from(b.subarray(0, 32), (x) => x.toString(16).padStart(2, "0")).join("");
const shown = (b) => (b.length <= 4096 && b[0] === 0x3c ? JSON.stringify(decoder.decode(b.subarray(0, 200))) : hex(b));

export function usbTransport(device) {
    let iface = null;
    let inEp = 0;
    let outEp = 0;
    let packet = 512;
    return {
        kind: "usb",
        device,
        async open() {
            await device.open();
            if (!device.configuration) await device.selectConfiguration(1);
            for (const i of device.configuration.interfaces) {
                const eps = i.alternate.endpoints.filter((e) => e.type === "bulk");
                const ein = eps.find((e) => e.direction === "in");
                const eout = eps.find((e) => e.direction === "out");
                if (ein && eout) {
                    iface = i.interfaceNumber;
                    inEp = ein.endpointNumber;
                    outEp = eout.endpointNumber;
                    packet = eout.packetSize || 512;
                    break;
                }
            }
            if (iface === null) throw new Stop("The phone in EDL mode has no bulk endpoints to talk to.");
            await device.claimInterface(iface);
        },
        async read() {
            try {
                const r = await device.transferIn(inEp, 1 << 20);
                return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
            } catch (e) {
                if (["NetworkError", "NotFoundError", "AbortError", "InvalidStateError"].includes(e?.name)) return null;
                throw e;
            }
        },
        async write(bytes, raw = false) {
            await device.transferOut(outEp, bytes);
            // XML that fills whole packets needs a zero-length packet to end it; raw sector data waits for zlp()
            if (!raw && bytes.length && bytes.length % packet === 0) await device.transferOut(outEp, new Uint8Array(0));
        },
        zlp: () => device.transferOut(outEp, new Uint8Array(0)),
        async close() {
            if (iface !== null) await device.releaseInterface(iface).catch(() => {});
            await device.close().catch(() => {});
        },
    };
}

export class Link {
    constructor(transport) {
        this.transport = transport;
        this.chunks = [];
        this.length = 0;
        this.closed = true;
        this.error = null;
        this.wake = null;
    }

    async open() {
        await this.transport.open();
        this.chunks = [];
        this.length = 0;
        this.closed = false;
        this.error = null;
        this.pumping = this.#pump();
    }

    async #pump() {
        try {
            for (;;) {
                const chunk = await this.transport.read();
                if (!chunk) break;
                if (chunk.length) {
                    if (edl.trace && (chunk.length <= 4096 || !this.quiet)) edl.trace(`<< ${chunk.length} ${shown(chunk)}`);
                    this.chunks.push(chunk);
                    this.length += chunk.length;
                    this.wake?.();
                }
            }
        } catch (e) {
            this.error = e;
        }
        this.closed = true;
        this.wake?.();
    }

    async close() {
        await this.transport.close().catch(() => {});
        await this.pumping;
    }

    async write(bytes, raw = false) {
        if (this.closed) throw new Stop("The connection to the phone is closed.");
        edl.trace?.(`>> ${bytes.length} ${raw ? "raw" : shown(bytes)}`);
        let timer;
        const stuck = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Stop("The phone stopped taking data. Hold Power until it turns off, "
                + "enter EDL mode again, and connect straight away.")), 15000);
        });
        try {
            await Promise.race([bytes.length ? this.transport.write(bytes, raw) : this.transport.zlp(), stuck]);
        } finally {
            clearTimeout(timer);
        }
        edl.trace?.(">> done");
    }

    zlp() {
        return this.write(new Uint8Array(0), true);
    }

    async fill(n, ms) {
        const end = Date.now() + ms;
        while (this.length < n) {
            if (this.closed) {
                throw new Stop(`The phone went away${this.error ? ` (${this.error.message})` : ""}. `
                    + "Unplug it, put it back in EDL mode and try again.");
            }
            const left = end - Date.now();
            if (left <= 0) return false;
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, left);
                this.wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
            this.wake = null;
        }
        return true;
    }

    peek(n) {
        const out = new Uint8Array(Math.min(n, this.length));
        let at = 0;
        for (const c of this.chunks) {
            if (at >= out.length) break;
            const part = c.subarray(0, out.length - at);
            out.set(part, at);
            at += part.length;
        }
        return out;
    }

    take(n) {
        const out = this.peek(n);
        this.skip(out.length);
        return out;
    }

    takeChunk(max) {
        const c = this.chunks[0];
        if (!c) return new Uint8Array(0);
        const part = c.subarray(0, max);
        this.skip(part.length);
        return part;
    }

    skip(n) {
        this.length -= n;
        while (n > 0) {
            const c = this.chunks[0];
            if (c.length <= n) {
                n -= c.length;
                this.chunks.shift();
            } else {
                this.chunks[0] = c.subarray(n);
                n = 0;
            }
        }
    }

    async untilGone(ms) {
        const end = Date.now() + ms;
        while (!this.closed && Date.now() < end) {
            this.skip(this.length);
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, Math.min(500, Math.max(0, end - Date.now())));
                this.wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
            this.wake = null;
        }
        return this.closed;
    }

    async drain(idleMs = 300) {
        do this.skip(this.length);
        while (await this.fill(1, idleMs));
    }
}

const HELLO = 0x01, HELLO_RESP = 0x02, READ_DATA = 0x03, END_IMAGE = 0x04;
const DONE = 0x05, DONE_RESP = 0x06, RESET = 0x07, READ_DATA_64 = 0x12;

const u32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
const u64 = (b, o) => Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true));

function pack32(...values) {
    const out = new Uint8Array(values.length * 4);
    const view = new DataView(out.buffer);
    values.forEach((v, i) => view.setUint32(i * 4, v, true));
    return out;
}

function isHello(link) {
    if (link.length < 8) return false;
    const head = link.peek(8);
    return u32(head, 0) === HELLO && u32(head, 4) === 48;
}

async function saharaPacket(link, ms) {
    if (!await link.fill(8, ms)) throw new Stop("The phone stopped answering (Sahara).");
    const head = link.peek(8);
    const cmd = u32(head, 0);
    const length = u32(head, 4);
    if (length < 8 || length > 0x10000) throw new Stop(`Bad Sahara packet (command 0x${cmd.toString(16)}, length ${length}).`);
    if (!await link.fill(length, ms)) throw new Stop("The phone stopped in the middle of a Sahara packet.");
    return { cmd, body: link.take(length).subarray(8) };
}

const HELLO_RESPONSE = pack32(HELLO_RESP, 48, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0);

async function saharaUpload(link, loader, ui, answered = false) {
    let mode = 0;
    if (!answered) {
        const hello = await saharaPacket(link, 5000);
        if (hello.cmd !== HELLO) throw new Stop(`Expected a Sahara HELLO, got 0x${hello.cmd.toString(16)}.`);
        mode = u32(hello.body, 12);
        await link.write(HELLO_RESPONSE);
    }
    ui.log(`Uploading the programmer (${(loader.length / 1024).toFixed(0)} KB)…`);
    const end = Date.now() + 90000;
    let sent = 0;
    while (Date.now() < end) {
        const { cmd, body } = await saharaPacket(link, 10000);
        if (cmd === READ_DATA || cmd === READ_DATA_64) {
            const offset = cmd === READ_DATA ? u32(body, 4) : u64(body, 8);
            const length = cmd === READ_DATA ? u32(body, 8) : u64(body, 16);
            if (offset + length > loader.length) throw new Stop("The phone asked for more of the programmer than there is.");
            await link.write(loader.subarray(offset, offset + length));
            sent += length;
            ui.progress(Math.min(sent, loader.length), loader.length);
        } else if (cmd === END_IMAGE) {
            const status = u32(body, 4);
            if (status !== 0) {
                throw new Stop(mode === 2
                    ? "The phone is in crash-dump EDL (Sahara mode 2), which takes no programmer. Hold Power to turn it "
                    + "off, then enter EDL again with Volume Up + Volume Down."
                    : `The phone refused the programmer (status 0x${status.toString(16)}).`);
            }
            await link.write(pack32(DONE, 8));
            const done = await saharaPacket(link, 8000);
            if (done.cmd !== DONE_RESP) throw new Stop(`Expected Sahara DONE, got 0x${done.cmd.toString(16)}.`);
            ui.progress();
            return;
        } else if (cmd === RESET) {
            throw new Stop("The phone asked for a Sahara reset.");
        } else {
            throw new Stop(`Unexpected Sahara command 0x${cmd.toString(16)}.`);
        }
    }
    throw new Stop("The programmer upload timed out.");
}

const ATTR = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
const LOG = /<log\b[^>]*\bvalue\s*=\s*"([^"]*)"/g;
const unescape = (s) => s.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const END_DATA = encoder.encode("</data>");

function indexOf(hay, needle) {
    outer: for (let i = 0; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return i;
    }
    return -1;
}

export class Firehose {
    constructor(link, ui) {
        this.link = link;
        this.ui = ui;
        this.sectorSize = 512;
        this.toTarget = 1 << 20;
        this.fromTarget = 1 << 20;
        this.storage = null;
    }

    send(element) {
        return this.link.write(encoder.encode(`<?xml version="1.0" encoding="UTF-8" ?><data>${element}</data>`));
    }

    async nextDocument(ms) {
        const end = Date.now() + ms;
        for (;;) {
            const at = indexOf(this.link.peek(this.link.length), END_DATA);
            if (at >= 0) return decoder.decode(this.link.take(at + END_DATA.length));
            const left = end - Date.now();
            if (left <= 0 || !await this.link.fill(this.link.length + 1, left)) return null;
        }
    }

    async response(ms = 10000, what = "command") {
        const logs = [];
        const end = Date.now() + ms;
        for (;;) {
            const doc = await this.nextDocument(Math.max(0, end - Date.now()));
            if (doc === null) {
                throw new Stop(`No answer to ${what} within ${Math.round(ms / 1000)} s.`
                    + (logs.length ? ` The phone said: ${logs.slice(-3).join(" | ")}` : ""));
            }
            for (const m of doc.matchAll(LOG)) logs.push(unescape(m[1]));
            const r = doc.match(/<response\b([^>]*)\/?>/);
            if (r) {
                const attrs = Object.fromEntries([...r[1].matchAll(ATTR)].map((m) => [m[1], m[2]]));
                return { ack: (attrs.value || "").toUpperCase() === "ACK", attrs, logs };
            }
        }
    }

    async command(element, ms, what) {
        await this.send(element);
        return this.response(ms, what || element.split(/\s/)[0].slice(1));
    }

    async ping() {
        try {
            await this.link.drain(300);
            return (await this.command("<nop />", 3000, "nop")).ack;
        } catch {
            return false;
        }
    }

    async configure() {
        const send = () => this.command(`<configure MemoryName="eMMC" ZLPAwareHost="1" SkipStorageInit="0" `
            + `MaxPayloadSizeToTargetInBytes="${this.toTarget}" MaxPayloadSizeFromTargetInBytes="${this.fromTarget}" `
            + "MaxXMLSizeInBytes=\"4096\" MemoryTool=\"1\" verbose=\"0\" />", 10000, "configure");
        let r = null;
        for (let i = 0; i < 2 && !r; i++) {
            await this.link.drain(i ? 1000 : 500);
            r = await send().catch((e) => (i ? Promise.reject(e) : null));
        }
        const supported = r.attrs.MaxPayloadSizeToTargetInBytesSupported || r.attrs.MaxPayloadSizeToTargetInBytes;
        if (!r.ack && supported && Number(supported) !== this.toTarget) {
            this.toTarget = Number(supported);
            r = await send();
        }
        if (r.ack) {
            this.toTarget = Number(r.attrs.MaxPayloadSizeToTargetInBytes || this.toTarget);
            this.fromTarget = Number(r.attrs.MaxPayloadSizeFromTargetInBytes || this.fromTarget);
        }
        return r.ack;
    }

    async storageInfo() {
        const r = await this.command('<getstorageinfo physical_partition_number="0" />', 10000, "getstorageinfo");
        for (const line of r.logs) {
            const m = line.match(/\{.*\}/s);
            if (!m || !m[0].includes("storage_info")) continue;
            let info;
            try {
                info = JSON.parse(m[0]).storage_info;
            } catch {
                continue;
            }
            // a programmer that never got its configure still answers, with a block size of 0
            if (Number(info.block_size) !== 512 || !(Number(info.total_blocks) > 0)) return null;
            this.storage = info;
            return info;
        }
        return null;
    }

    // The TCL programmer can send sector data straight away, without the rawmode ACK first.
    async read(start, count, sink) {
        const total = count * this.sectorSize;
        await this.send(`<read SECTOR_SIZE_IN_BYTES="${this.sectorSize}" num_partition_sectors="${count}" `
            + `physical_partition_number="0" start_sector="${start}" />`);
        const end = Date.now() + 10000;
        for (;;) {
            if (!this.link.length && !await this.link.fill(1, Math.max(0, end - Date.now()))) {
                throw new Stop("No answer to read within 10 s.");
            }
            const head = decoder.decode(this.link.peek(16)).trimStart();
            if (!head.startsWith("<?xml")) break;
            const doc = await this.nextDocument(Math.max(0, end - Date.now()));
            if (doc === null) throw new Stop("Half an answer to read.");
            const r = doc.match(/<response\b([^>]*)\/?>/);
            if (r && !/value="ACK"/i.test(r[1])) {
                const logs = [...doc.matchAll(LOG)].map((m) => unescape(m[1]));
                throw new Stop(`The phone refused to read sectors ${start}+${count}: ${logs.slice(-3).join(" | ") || r[1]}`);
            }
        }
        let got = 0;
        while (got < total) {
            if (!this.link.length && !await this.link.fill(1, 15000)) {
                throw new Stop(`The phone stopped sending after ${got} of ${total} bytes.`);
            }
            const chunk = this.link.takeChunk(total - got);
            got += chunk.length;
            await sink(chunk);
        }
        const tail = await this.response(10000, "the end of read");
        if (!tail.ack) throw new Stop(`The read finished but the phone reported a failure: ${tail.logs.slice(-3).join(" | ")}`);
    }

    // The TCL programmer only answers a <program> after the zero-length packet that ends the data.
    async program(start, data) {
        const count = data.length / this.sectorSize;
        if (!Number.isInteger(count) || !count) throw new Stop("Internal error: program needs whole sectors.");
        await this.send(`<program SECTOR_SIZE_IN_BYTES="${this.sectorSize}" num_partition_sectors="${count}" `
            + `physical_partition_number="0" start_sector="${start}" filename="" />`);
        // The first program waits 3 s to see whether this programmer says rawmode="true" before the data.
        let r = { ack: true, attrs: {}, logs: [] };
        if (this.opensProgram !== false) {
            r = await this.response(3000, "program").catch(() => null);
            if (this.opensProgram === undefined) this.opensProgram = r !== null;
            r ??= { ack: true, attrs: {}, logs: [] };
        }
        if (!r.ack) throw new Stop(`The phone refused to write sectors ${start}+${count}: ${r.logs.slice(-3).join(" | ") || r.attrs.value}`);
        const every = Number(r.attrs.AckRawDataEveryNumPackets || 0);
        const piece = Math.max(this.sectorSize, Math.floor(this.toTarget / this.sectorSize) * this.sectorSize);
        let packets = 0;
        for (let at = 0; at < data.length; at += piece) {
            await this.link.write(data.subarray(at, at + piece), true);
            if (every && ++packets % every === 0) {
                const mid = await this.response(10000, "the data");
                if (!mid.ack) throw new Stop(`The phone stopped taking data at sector ${start + at / this.sectorSize}.`);
            }
        }
        await this.link.zlp();
        try {
            r = await this.response(60000, "the end of program");
            while (r.ack && (r.attrs.rawmode || "").toLowerCase() === "true") r = await this.response(60000, "the end of program");
        } catch (e) {
            throw new Stop(`The phone didn't confirm writing sectors ${start}+${count} (${e.message}).`);
        }
        if (!r.ack) throw new Stop(`The phone said writing sectors ${start}+${count} failed: ${r.logs.slice(-3).join(" | ")}`);
    }

    async reset(value = "reset") {
        let r;
        try {
            r = await this.command(`<power value="${value}"/>`, 5000, "power");
        } catch {
            return null;
        }
        return { ...r, gone: r.ack ? await this.link.untilGone(15000) : false };
    }
}

async function reconnect(link, reopen, what) {
    await link.close();
    await sleep(1500);
    const end = Date.now() + 25000;
    for (;;) {
        try {
            const again = new Link(await reopen());
            await again.open();
            return again;
        } catch (e) {
            if (Date.now() > end) throw new Stop(`The phone didn't come back after ${what} (${e.message}).`);
            await sleep(500);
        }
    }
}

export async function startEdl({ transport, loader, ui, reopen }) {
    let link = new Link(transport);
    await link.open();
    await link.fill(8, 1000);
    let hello = isHello(link);
    let answered = false;
    if (!hello) {
        // A programmer that's already running ignores this
        await link.write(HELLO_RESPONSE);
        if (await link.fill(8, 2000)) {
            const cmd = u32(link.peek(8), 0);
            answered = cmd === READ_DATA || cmd === READ_DATA_64;
            hello = isHello(link);
        }
    }
    let configured = false;
    if (hello || answered) {
        await saharaUpload(link, loader, ui, answered);
        ui.log("Waiting for the programmer to start…");
        link = await reconnect(link, reopen, "the programmer upload");
    } else {
        configured = await new Firehose(link, ui).ping();
        if (!configured) {
            throw new Stop("The phone in EDL mode didn't answer. Hold Power to turn it off, enter EDL again, and retry.");
        }
        ui.log("The programmer is already running from before; using it.");
    }

    const fh = new Firehose(link, ui);
    // The programmer takes configure once per boot
    const open = async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                return !!await fh.storageInfo();
            } catch {
                await link.drain(500);
                await sleep(1000);
            }
        }
        return false;
    };
    if (configured && await open()) return { link, fh };
    if (await fh.configure().catch(() => false) && await open()) return { link, fh };
    await link.close();
    throw new Stop(configured
        ? "The programmer still running from before isn't set up for this phone's eMMC. Hold Power until the phone "
        + "turns off, enter EDL mode again, and connect."
        : "The programmer started but couldn't open the phone's eMMC. Hold Power until the phone turns off, enter EDL "
        + "mode again, and connect.");
}

export async function backup({ fh, sink, ui, from = 0, chunkSectors = 65536, stopped = () => false }) {
    const total = Number(fh.storage?.total_blocks || 0);
    if (!total) throw new Stop("The phone didn't say how big its storage is.");
    const size = total * fh.sectorSize;
    let done = from * fh.sectorSize;
    const started = Date.now();
    for (let sector = from; sector < total; sector += chunkSectors) {
        if (stopped()) throw new Stop(`Stopped at sector ${sector}.`);
        const count = Math.min(chunkSectors, total - sector);
        await fh.read(sector, count, async (bytes) => {
            await sink(bytes);
            done += bytes.length;
        });
        const rate = (done - from * fh.sectorSize) / Math.max(1, (Date.now() - started) / 1000);
        ui.progress(done, size, rate);
    }
    ui.progress();
    return { sectors: total, bytes: size };
}

function gptHeader(head) {
    if (decoder.decode(head.subarray(0, 8)) !== "EFI PART") throw new Stop("No GPT header where the partition table says.");
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return {
        diskGuid: Array.from(head.subarray(56, 72), (x) => x.toString(16).padStart(2, "0")).join(""),
        otherLba: Number(view.getBigUint64(32, true)),
        firstUsable: Number(view.getBigUint64(40, true)),
        entriesLba: Number(view.getBigUint64(72, true)),
        count: view.getUint32(80, true),
        size: view.getUint32(84, true),
    };
}

export function parseGpt(bytes, sectorSize = 512) {
    const h = gptHeader(bytes.subarray(sectorSize, sectorSize * 2));
    const { entriesLba, count, size } = h;
    const backupLba = h.otherLba;
    const sectors = Math.max(h.firstUsable, entriesLba + Math.ceil((count * size) / sectorSize));
    const parts = [];
    if (bytes.length >= sectors * sectorSize) {
        for (let i = 0; i < count; i++) {
            const e = bytes.subarray(entriesLba * sectorSize + i * size, entriesLba * sectorSize + (i + 1) * size);
            const ev = new DataView(e.buffer, e.byteOffset, e.byteLength);
            const unused = e.subarray(0, 16).every((x) => x === 0);
            if (unused) continue;
            const first = Number(ev.getBigUint64(32, true));
            const last = Number(ev.getBigUint64(40, true));
            const name = new TextDecoder("utf-16le").decode(e.subarray(56, 128)).replace(/\0.*$/s, "");
            parts.push({ name, first, last, sectors: last - first + 1, attributes: ev.getBigUint64(48, true) });
        }
    }
    return { sectors, backupLba, parts, diskGuid: h.diskGuid };
}

export async function readGpt(fh) {
    const read = async (count) => {
        const chunks = [];
        await fh.read(0, count, (b) => chunks.push(b.slice()));
        const out = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
        chunks.reduce((at, b) => (out.set(b, at), at + b.length), 0);
        return out;
    };
    let bytes = await read(34);
    const { sectors } = parseGpt(bytes, fh.sectorSize);
    if (sectors > 34) bytes = await read(sectors);
    const gpt = parseGpt(bytes, fh.sectorSize);
    const tail = [];
    await fh.read(gpt.backupLba, 1, (b) => tail.push(b.slice()));
    const backup = gptHeader(tail.length === 1 ? tail[0] : new Uint8Array(tail.flatMap((b) => [...b])));
    if (backup.otherLba !== 1 || backup.entriesLba >= gpt.backupLba) throw new Stop("The backup partition table doesn't match the main one.");
    return { bytes, ...gpt, backupEntriesLba: backup.entriesLba };
}

const ACTIVE = 1n << 50n;

export function changedPartitions(gpt, ota) {
    const byName = new Map(gpt.parts.map((p) => [p.name, p]));
    const active = ["a", "b"].filter((s) => (byName.get(`boot_${s}`)?.attributes ?? 0n) & ACTIVE);
    const targets = active.length === 1 ? [active[0] === "a" ? "b" : "a"] : ["a", "b"];
    const items = [];
    const missing = [];
    const add = (p, file) => items.push({ file: file ?? `${p.name}.img`, first: p.first, sectors: p.sectors });
    items.push({ file: "gpt/gpt_main0.bin", first: 0, sectors: gpt.sectors });
    items.push({ file: "gpt/gpt_backup0.bin", first: gpt.backupEntriesLba, sectors: gpt.backupLba - gpt.backupEntriesLba + 1 });
    for (const name of ["misc", "metadata", ...(ota.logical.length ? ["super"] : [])]) {
        if (byName.has(name)) add(byName.get(name));
        else missing.push(name);
    }
    for (const name of ota.physical) {
        const slotted = targets.map((s) => byName.get(`${name}_${s}`)).filter(Boolean);
        if (slotted.length) slotted.forEach((p) => add(p));
        else if (byName.has(name)) add(byName.get(name));
        else missing.push(name);
    }
    return { slot: targets.length === 1 ? targets[0] : null, items, missing };
}

export async function backupParts({ fh, items, open, ui, done = new Set(), stopped = () => false, chunkSectors = 65536 }) {
    const total = items.reduce((n, i) => n + i.sectors, 0) * fh.sectorSize;
    let got = items.filter((i) => done.has(i.file)).reduce((n, i) => n + i.sectors, 0) * fh.sectorSize;
    const startedAt = got;
    const started = Date.now();
    for (const item of items) {
        if (done.has(item.file)) continue;
        if (stopped()) throw new Stop(`Stopped before ${item.file}.`);
        ui.log(`${item.file} (${(item.sectors * fh.sectorSize / 1e6).toFixed(1)} MB)`);
        const sink = await open(item);
        try {
            for (let s = 0; s < item.sectors; s += chunkSectors) {
                if (stopped()) throw new Stop(`Stopped in ${item.file}.`);
                await fh.read(item.first + s, Math.min(chunkSectors, item.sectors - s), async (bytes) => {
                    await sink.write(bytes);
                    got += bytes.length;
                });
                ui.progress(got, total, (got - startedAt) / Math.max(1, (Date.now() - started) / 1000));
            }
        } finally {
            await sink.close();
        }
        done.add(item.file);
    }
    ui.progress();
    return { bytes: total };
}

export function restoreText(ota, plan, sectorSize) {
    const backupGpt = plan.items.find((i) => i.file === "gpt/gpt_backup0.bin");
    const parts = plan.items.filter((i) => !i.file.startsWith("gpt/")).map((i) => i.file.replace(/\.img$/, ""));
    return [
        `TCL Flip 4 (T440W) partition backup, made ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
        `with the sideload page, before flashing ${ota.name}.`,
        "",
        "It holds what that OTA changes, as the phone was before it:",
        plan.slot
            ? `- the partitions it writes, in slot ${plan.slot}, the slot the phone wasn't running (the running one isn't touched)`
            : "- the partitions it writes, in both slots (the active slot couldn't be told from the partition table)",
        "- super (system, vendor, product...: after the first good boot the update is merged into it)",
        "- misc and metadata (update and snapshot state)",
        "- gpt/: both copies of the partition table, which hold the A/B slot bits",
        "",
        `Partitions: ${parts.join(", ")}`,
        "",
        "To write it back, put the phone in EDL mode and, from the flip4-ota-patches folder:",
        "",
        "  ./edl wl \"<this folder>\" --loader=loader/flip-4-edl.bin --memory=emmc",
        "",
        "writes each <partition>.img here to the partition of that name. To put the slot bits back too:",
        "",
        "  ./edl ws 0 \"<this folder>/gpt/gpt_main0.bin\" --loader=loader/flip-4-edl.bin --memory=emmc",
        `  ./edl ws ${backupGpt.first} "<this folder>/gpt/gpt_backup0.bin" --loader=loader/flip-4-edl.bin --memory=emmc`,
        "",
        `Sector size ${sectorSize}. Only write it to the phone it came from.`,
        "",
    ].join("\n");
}

export function sameLayout(gpt, theirs, what) {
    if (theirs.diskGuid !== gpt.diskGuid) {
        throw new Stop(`${what} is from another phone (its disk GUID is ${theirs.diskGuid}, this phone's is ${gpt.diskGuid}).`);
    }
    const key = (p) => `${p.name}:${p.first}:${p.last}`;
    const mine = gpt.parts.map(key).join(",");
    if (theirs.parts.map(key).join(",") !== mine) throw new Stop(`${what} has a different partition layout from this phone's.`);
}

export function imagePlan(gpt, head, size, sectorSize, total) {
    if (size !== total * sectorSize) {
        throw new Stop(`The image is ${size} bytes; this phone's eMMC is ${total * sectorSize}. It isn't a whole-eMMC backup of it.`);
    }
    sameLayout(gpt, parseGpt(head, sectorSize), "The image");
    const at = (first, sectors, name) => ({ name, first, sectors, offset: first * sectorSize });
    return [
        at(gpt.sectors, gpt.backupEntriesLba - gpt.sectors, "everything between the partition tables"),
        at(gpt.backupEntriesLba, gpt.backupLba - gpt.backupEntriesLba + 1, "the backup partition table"),
        at(0, gpt.sectors, "the partition table"),
    ];
}

export function folderPlan(gpt, files, mainGpt, sectorSize) {
    if (!mainGpt) throw new Stop("The folder has no gpt/gpt_main0.bin, so it can't be checked against this phone.");
    sameLayout(gpt, parseGpt(mainGpt, sectorSize), "The folder's partition table");
    const byName = new Map(gpt.parts.map((p) => [p.name, p]));
    const items = [];
    const skipped = [];
    for (const f of files) {
        if (f.path.startsWith("gpt/") || !f.path.endsWith(".img")) continue;
        const part = byName.get(f.path.slice(0, -4));
        if (!part) skipped.push(`${f.path}: no partition of that name`);
        else if (f.size % sectorSize || f.size > part.sectors * sectorSize) skipped.push(`${f.path}: doesn't fit ${part.name}`);
        else if (!f.size) skipped.push(`${f.path}: empty`);
        else items.push({ name: part.name, path: f.path, first: part.first, sectors: f.size / sectorSize, offset: 0 });
    }
    const backup = files.find((f) => f.path === "gpt/gpt_backup0.bin");
    const backupSectors = gpt.backupLba - gpt.backupEntriesLba + 1;
    if (backup && backup.size === backupSectors * sectorSize) {
        items.push({ name: "the backup partition table", path: backup.path, first: gpt.backupEntriesLba, sectors: backupSectors, offset: 0 });
    } else if (backup) {
        skipped.push(`${backup.path}: not the size of this phone's backup table`);
    }
    if (mainGpt.length !== gpt.sectors * sectorSize) throw new Stop("gpt/gpt_main0.bin isn't the size of this phone's partition table.");
    items.push({ name: "the partition table", path: "gpt/gpt_main0.bin", first: 0, sectors: gpt.sectors, offset: 0 });
    return { items, skipped };
}

export async function restore({ fh, items, source, ui, verify = true, stopped = () => false, chunkSectors = 65536 }) {
    const total = items.reduce((n, i) => n + i.sectors, 0) * fh.sectorSize;
    let done = 0;
    const started = Date.now();
    for (const item of items) {
        ui.log(`Writing ${item.name} (${(item.sectors * fh.sectorSize / 1e6).toFixed(1)} MB)${verify ? " and checking it" : ""}…`);
        for (let s = 0; s < item.sectors; s += chunkSectors) {
            if (stopped()) throw new Stop(`Stopped in ${item.name}, at sector ${item.first + s}.`);
            const n = Math.min(chunkSectors, item.sectors - s);
            const data = await source(item, item.offset + s * fh.sectorSize, n * fh.sectorSize);
            if (data.length !== n * fh.sectorSize) throw new Stop(`The backup file ended early in ${item.name}.`);
            await fh.program(item.first + s, data);
            if (verify) {
                let at = 0;
                await fh.read(item.first + s, n, (bytes) => {
                    for (let i = 0; i < bytes.length; i++) {
                        if (bytes[i] !== data[at + i]) {
                            throw new Stop(`Checking ${item.name}: sector ${item.first + s + Math.floor((at + i) / fh.sectorSize)} on the phone `
                                + "doesn't match the backup after writing it.");
                        }
                    }
                    at += bytes.length;
                });
            }
            done += data.length;
            ui.progress(done, total, done / Math.max(1, (Date.now() - started) / 1000));
        }
    }
    ui.progress();
    return { bytes: total };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function gptIntact(header, entries) {
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const size = view.getUint32(12, true);
    const copy = header.slice(0, size);
    new DataView(copy.buffer).setUint32(16, 0, true);
    const count = view.getUint32(80, true) * view.getUint32(84, true);
    return crc32(copy) === view.getUint32(16, true) && crc32(entries.subarray(0, count)) === view.getUint32(88, true);
}

export function checkGptFiles(main, backup, sectorSize) {
    if (!gptIntact(main.subarray(sectorSize, sectorSize * 2), main.subarray(sectorSize * 2))) {
        throw new Stop("The backup's partition table is damaged (its checksum doesn't match). Not writing it.");
    }
    if (backup && !gptIntact(backup.subarray(backup.length - sectorSize), backup.subarray(0, backup.length - sectorSize))) {
        throw new Stop("The backup's second partition table is damaged (its checksum doesn't match). Not writing it.");
    }
}
