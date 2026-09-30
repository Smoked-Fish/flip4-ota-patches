#!/usr/bin/env python3
"""
Shared logic for the TCL Flip 4 (T440W) "force sideload over EDL" helpers
"""

import codecs
import os
import re
import struct
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_EDL = HERE / "edlclient" / "edl.py"
DEFAULT_LOADER = HERE / "loader" / "flip-4-edl.bin"
BACKUP_DIR = HERE / "misc-backups"

VID, PID = 0x05C6, 0x9008

BCB_SIZE = 2048
CMD_OFF, CMD_LEN = 0, 32
STATUS_OFF, STATUS_LEN = 32, 32
RECOVERY_OFF, RECOVERY_LEN = 64, 768
STAGE_OFF, STAGE_LEN = 832, 32

MISC_LBA = 300032                # misc start, cross-checked at run time
VAB_OFF = 0x8000                 # Virtual A/B merge message, must survive untouched
VAB_MAGIC = 0x56740AB0           # stored at 0x8001, after the version byte
SECTOR = 512

# edl.py prints a lot, only KEEP lines minus NOISE reach the screen
NOISE = re.compile(r"USBError|'NoneType' object is not callable|Couldn't detect (MaxPayload|TargetName)")
KEEP = re.compile(r"Dumped sector|Wrote .* to sector|Reading from physical|Loader successfully uploaded"
                  r"|Reset succeeded|Reset failed|Error|error|Traceback|Couldn't|Usage:")


def field(buf, off, length):
    return bytes(buf[off:off + length]).split(b"\0", 1)[0].decode("ascii", "replace")


def build_bcb(opts):
    bcb = bytearray(BCB_SIZE)
    bcb[CMD_OFF:CMD_OFF + 13] = b"boot-recovery"
    rec = ("recovery\n" + "".join(o + "\n" for o in opts)).encode("ascii")
    if len(rec) >= RECOVERY_LEN:
        sys.exit("recovery args do not fit in the BCB")
    bcb[RECOVERY_OFF:RECOVERY_OFF + len(rec)] = rec
    return bcb


def show_bcb(label, img):
    print(f"  {label}")
    print(f"    command : {field(img, CMD_OFF, CMD_LEN)!r}")
    print(f"    status  : {field(img, STATUS_OFF, STATUS_LEN)!r}")
    print(f"    recovery: {field(img, RECOVERY_OFF, RECOVERY_LEN)!r}")
    print(f"    stage   : {field(img, STAGE_OFF, STAGE_LEN)!r}")


def run_edl(args, log, what, cmd, memory=True, skipresponse=False, expect=None):
    full = [sys.executable, str(args.edl), *cmd, f"--loader={args.loader}"]
    if memory:                       # `reset` does not accept --memory
        full.append("--memory=emmc")
    if skipresponse:                 # the GPT and sector reads need it on this loader
        full.append("--skipresponse")
    # edl.py imports itself as the `edlclient` package, so its parent dir must be importable.
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(args.edl.parent.parent), env.get("PYTHONPATH")]))
    env["PYTHONIOENCODING"] = "utf-8"    # the progress bar uses block characters
    env["PYTHONUNBUFFERED"] = "1"

    print(f"  edl: {what}")
    proc = subprocess.Popen(full, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    dec = codecs.getincrementaldecoder("utf-8")("replace")
    lines, buf = [], ""
    with open(log, "a", encoding="utf-8") as f:
        f.write(f"\n$ {' '.join(full)}\n")
        while True:
            chunk = os.read(proc.stdout.fileno(), 4096)
            buf += dec.decode(chunk, final=not chunk)
            parts = re.split(r"[\r\n]+", buf)
            buf = "" if not chunk else parts.pop()
            for seg in parts:
                seg = seg.rstrip()
                if not seg:
                    continue
                f.write(seg + "\n")
                lines.append(seg)
                if KEEP.search(seg) and not NOISE.search(seg):
                    print(f"    {seg}")
            if not chunk:
                break
    rc = proc.wait()
    text = "\n".join(lines)
    if rc != 0 or "Usage:" in text or (expect and not re.search(expect, text)):
        print(f"\nedl.py did not report success for: {what} (exit {rc}). Last output:")
        for seg in [s for s in lines if not NOISE.search(s)][-15:]:
            print(f"    {seg}")
        sys.exit(f"Full log: {log}\nThe original misc is saved in {BACKUP_DIR}.")


def read_misc(args, log, path):
    run_edl(args, log, f"read misc -> {path.name}", ["r", "misc", str(path)],
            skipresponse=True, expect=r"Dumped sector")
    data = path.read_bytes()
    if len(data) < BCB_SIZE or len(data) % SECTOR:
        sys.exit(f"Unexpected misc size {len(data)} bytes; refusing to go on.")
    return data


def read_sectors(args, log, count, path):
    run_edl(args, log, f"read sectors {args.misc_lba}+{count}",
            ["rs", str(args.misc_lba), str(count), str(path)],
            skipresponse=True, expect=r"Dumped sector")
    return path.read_bytes()


def write_misc(args, log, path):
    # `w misc` finds the partition through the GPT, which comes back empty without
    # --skipresponse, and edl.py still exits 0. `ws` needs no GPT.
    run_edl(args, log, f"write {path.name} -> sector {args.misc_lba}",
            ["ws", str(args.misc_lba), str(path)], expect=r"Wrote .* to sector")


def reset_phone(args, log):
    run_edl(args, log, "reset phone", ["reset", "--resetmode=reset"], memory=False)


def confirm(prompt):
    try:
        return input(prompt).strip().lower() in ("y", "yes")
    except EOFError:
        return False


def add_args(ap):
    ap.add_argument("--restore", type=Path, metavar="FILE",
                    help="write a saved misc image back instead of requesting sideload")
    ap.add_argument("--dry-run", action="store_true",
                    help="read misc, show what would change, write nothing")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    ap.add_argument("--misc-lba", type=int, default=MISC_LBA,
                    help=f"start sector of misc (default {MISC_LBA}); checked against a by-name read first")
    ap.add_argument("--edl", type=Path, default=DEFAULT_EDL)
    ap.add_argument("--loader", type=Path, default=DEFAULT_LOADER)


def check_args(args):
    if not args.edl.is_file():
        sys.exit(f"edl.py not found at {args.edl} (use --edl)")
    if not args.loader.is_file():
        sys.exit(f"loader not found at {args.loader} (use --loader)")
    if args.restore and not args.restore.is_file():
        sys.exit(f"{args.restore} not found")


def tidy(orig_path, scratch):
    for p in scratch:
        p.unlink(missing_ok=True)
    data = orig_path.read_bytes()
    for old in sorted(BACKUP_DIR.glob("misc-*-original.bin")):
        if old != orig_path and old.stat().st_size == len(data) and old.read_bytes() == data:
            orig_path.unlink()
            return old
    return orig_path


def run_flow(args, device_present):
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    orig_path = BACKUP_DIR / f"misc-{stamp}-original.bin"
    new_path = BACKUP_DIR / f"misc-{stamp}-new.bin"
    check_path = BACKUP_DIR / f"misc-{stamp}-readback.bin"
    pre_path = BACKUP_DIR / f"misc-{stamp}-lbacheck.bin"
    log = BACKUP_DIR / f"edl-{stamp}.log"
    scratch = [new_path, check_path, pre_path]

    print("[1/4] Reading misc (backup, nothing is changed yet)")
    orig = read_misc(args, log, orig_path)
    print(f"  saved {len(orig)} bytes to {orig_path}")
    if read_sectors(args, log, len(orig) // SECTOR, pre_path) != orig:
        sys.exit(f"Sector {args.misc_lba} does not hold misc on this phone (by-name read differs)\nNot writing anything. Use --misc-lba.")
    pre_path.unlink()
    print(f"  sector {args.misc_lba} matches the by-name read of misc")
    show_bcb("current BCB:", orig)
    if len(orig) > VAB_OFF + 8:
        # misc_virtual_ab_message is packed: u8 version, u32 magic, ...
        version = orig[VAB_OFF]
        magic = struct.unpack_from("<I", orig, VAB_OFF + 1)[0]
        print(f"  Virtual A/B message at 0x8000: version {version}, magic {magic:#010x} (present, will be preserved)" if magic == VAB_MAGIC else "")

    if args.restore:
        new = bytearray(args.restore.read_bytes())
        if len(new) != len(orig):
            sys.exit(f"{args.restore} is {len(new)} bytes but misc is {len(orig)}; refusing.")
        what = f"restore {args.restore.name}"
    else:
        new = bytearray(orig)
        new[:BCB_SIZE] = build_bcb(["--sideload"])
        what = "request --sideload"
    show_bcb("BCB to write:", new)
    print(f"  {sum(1 for a, b in zip(orig, new) if a != b)} byte(s) differ from the current misc")
    new_path.write_bytes(bytes(new))

    if args.dry_run:
        print("\nDry run: nothing written.")
        print(f"Backup of misc: {tidy(orig_path, scratch)}")
        return
    if bytes(new) == bytes(orig):
        print("\nmisc already holds this content; nothing to write.")
    else:
        cmd = field(orig, CMD_OFF, CMD_LEN)
        if cmd and cmd != "boot-recovery":
            print(f"\nNote: the current command is {cmd!r}, which this will replace.")
        if not args.yes and not confirm(f"\nWrite to misc now ({what})? [y/N] "):
            print("Aborted, nothing written.")
            print(f"Backup of misc: {tidy(orig_path, scratch)}")
            return

        print("\n[2/4] Writing misc")
        write_misc(args, log, new_path)

        print("\n[3/4] Reading misc back to verify")
        back = read_misc(args, log, check_path)
        if back != bytes(new):
            bad = next((i for i, (a, b) in enumerate(zip(back, new)) if a != b), 0)
            sys.exit(f"Verify FAILED (first difference at byte {bad:#x}).\nUndo with --restore {orig_path}")
        print("  verified: misc matches what was written, bytes past 0x800 unchanged" if back[BCB_SIZE:] == orig[BCB_SIZE:] else "")

    print("\n[4/4] Resetting the phone")
    reset_phone(args, log)
    for _ in range(15):
        if not device_present():
            break
        time.sleep(1)
    else:
        print("  the 9008 port is still present; hold Power to leave EDL.")

    backup = tidy(orig_path, scratch)
    if args.restore:
        print("\nDone. The saved misc was written back.")
        print(f"The misc it replaced is saved as {backup}")
        return
    print("\nThe phone should boot recovery at the sideload screen.")
    print("On the PC:  adb devices      (expect '<serial>  sideload')")
    print("            adb sideload ota.zip")
    print("Recovery clears the request when it leaves sideload, so there is nothing to undo.")
    print(f"If the phone did not reach sideload: --restore {backup}")
    print(f"Full edl log: {log}")
