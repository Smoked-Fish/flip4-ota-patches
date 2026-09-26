#!/usr/bin/env python3
"""
Windows EDL backup helper for the TCL Flip 4 (T440W).
"""

import argparse
import ctypes
import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path

VID, PID = 0x05C6, 0x9008
INSTANCE_RE = re.compile(r"USB\\VID_05C6&PID_9008\\\S+", re.I)
OEM_INF_RE = re.compile(r"oem\d+\.inf", re.I)

HERE = Path(__file__).resolve().parent
DEFAULT_EDL = HERE / "edlclient" / "edl.py"
DEFAULT_LOADER = HERE / "loader" / "flip-4-edl.bin"
DEFAULT_WDI = HERE / "tools" / "wdi-simple.exe"

# libwdi driver types: 0 WinUSB, 1 libusb-win32, 2 libusbK.
DRIVERS = {"libusb0": 1, "winusb": 0, "libusbk": 2}

def is_admin():
    try:
        return ctypes.windll.shell32.IsUserAnAdmin()
    except Exception:
        return False


def relaunch_as_admin():
    params = " ".join(f'"{a}"' for a in sys.argv)
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, params, None, 1)
    if rc <= 32:
        sys.exit("Could not get Administrator rights; rerun from an elevated terminal.")
    sys.exit(0)


def run(cmd, **kw):
    print("+", " ".join(str(c) for c in cmd))
    return subprocess.run(cmd, **kw)


def ensure_deps(edl):
    if importlib.util.find_spec("docopt") and importlib.util.find_spec("usb"):
        return
    print("Installing the EDL client's Python dependencies...")
    req = next((p / "requirements.txt" for p in (edl.parent, edl.parent.parent)
                if (p / "requirements.txt").is_file()), None)
    cmd = [sys.executable, "-m", "pip", "install"]
    cmd += ["-r", str(req)]
    if run(cmd).returncode != 0:
        sys.exit("Dependency install failed. Install Python 3 with pip and retry.")


def oem_infs():
    out = run(["pnputil", "/enum-drivers"], capture_output=True, text=True).stdout or ""
    return {m.lower() for m in OEM_INF_RE.findall(out)}


def edl_instances():
    out = run(["pnputil", "/enum-devices", "/connected"], capture_output=True, text=True).stdout or ""
    return INSTANCE_RE.findall(out)


def install_driver(wdi, driver):
    if not wdi.is_file():
        sys.exit(f"wdi-simple.exe not found at {wdi}\n"
                 "Build from libwdi/Zadig or get from Timocop/libwdi-wdi-releases release and drop it in tools/.")
    r = run([str(wdi), "--vid", hex(VID), "--pid", hex(PID),
             "--type", str(DRIVERS[driver]), "--name", "TCL Flip 4 EDL"])
    if r.returncode != 0:
        sys.exit("Driver install failed. Is the phone in EDL mode and plugged in?")


def remove_driver(added):
    for inf in sorted(added):
        try:
            run(["pnputil", "/delete-driver", inf, "/uninstall", "/force"])
        except Exception as e:
            print(f"  could not remove {inf}: {e}")
    for inst in edl_instances():
        try:
            run(["pnputil", "/remove-device", inst])
        except Exception as e:
            print(f"  could not remove device {inst}: {e}")


def dump(edl, loader, image, write):
    verb = "wf" if write else "rf"
    cmd = [sys.executable, str(edl), verb, str(image), f"--loader={loader}", "--memory=emmc"]
    if not write:
        cmd.append("--skipresponse")
    # edl.py imports itself as the `edlclient` package, so its parent dir must be importable.
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(edl.parent.parent), env.get("PYTHONPATH")]))
    return run(cmd, env=env).returncode


def main():
    if sys.platform != "win32":
        sys.exit("This helper is for Windows. On Linux/macOS run edl.py directly.")

    ap = argparse.ArgumentParser(description="Temporary-driver EDL backup/restore for the TCL Flip 4.")
    ap.add_argument("image", nargs="?", default="flip4-full-emmc.img",
                    help="image file to write to (backup) or read from (--write)")
    ap.add_argument("--write", action="store_true", help="restore: write the image back to the phone")
    ap.add_argument("--edl", type=Path, default=DEFAULT_EDL)
    ap.add_argument("--loader", type=Path, default=DEFAULT_LOADER)
    ap.add_argument("--wdi", type=Path, default=DEFAULT_WDI)
    ap.add_argument("--driver", choices=DRIVERS, default="libusb0",
                    help="libusb driver to bind if the default doesn't enumerate (default: libusb0)")
    ap.add_argument("--skip-deps", action="store_true", help="don't auto-install the EDL client's Python deps")
    args = ap.parse_args()

    if not is_admin():
        relaunch_as_admin()

    if not args.edl.is_file():
        sys.exit(f"edl.py not found at {args.edl} (use --edl to point at it)")
    if not args.loader.is_file():
        sys.exit(f"loader not found at {args.loader} (use --loader to point at it)")

    if not args.skip_deps:
        ensure_deps(args.edl)

    before = oem_infs()
    rc = 1
    try:
        install_driver(args.wdi, args.driver)
        rc = dump(args.edl, args.loader, args.image, args.write)
    except KeyboardInterrupt:
        print("\nInterrupted.")
    finally:
        print("\nRemoving the temporary driver...")
        remove_driver(oem_infs() - before)

    if rc == 0 and not args.write:
        print(f"\nDone. Backup written to {args.image} -- keep it somewhere safe.")
    elif rc == 0:
        print("\nDone. Image written back to the phone.")
    else:
        sys.exit(f"\nedl exited with code {rc}.")


if __name__ == "__main__":
    main()