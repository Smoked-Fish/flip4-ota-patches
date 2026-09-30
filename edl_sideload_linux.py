#!/usr/bin/env python3
"""
python3 edl_sideload_linux.py               # then: adb sideload ota.zip
python3 edl_sideload_linux.py --dry-run     # read only, shows what would change
"""

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import edl_sideload_core as core

VENV = HERE / ".venv"
REQS = HERE / "edlclient" / "requirements.txt"
SYSFS_USB = Path("/sys/bus/usb/devices")


def find_edl_device():
    if not SYSFS_USB.is_dir():
        return None
    for d in SYSFS_USB.iterdir():
        try:
            if (int((d / "idVendor").read_text(), 16) == core.VID
                    and int((d / "idProduct").read_text(), 16) == core.PID):
                return d
        except (OSError, ValueError):
            continue
    return None


def usb_node(sysfs_dir):
    bus = int((sysfs_dir / "busnum").read_text())
    dev = int((sysfs_dir / "devnum").read_text())
    return Path(f"/dev/bus/usb/{bus:03d}/{dev:03d}")


def have_deps():
    return all(importlib.util.find_spec(m) for m in ("docopt", "usb", "Cryptodome", "serial"))


def ensure_deps():
    if have_deps():
        return
    if os.environ.get("EDL_SIDELOAD_REEXEC"):
        sys.exit(f"Dependencies still missing inside {VENV}. Try: {VENV}/bin/pip install -r {REQS}")
    py = VENV / "bin" / "python"
    marker = VENV / ".installed"
    if not py.is_file():
        print(f"Creating Python environment in {VENV} ...")
        if subprocess.run([sys.executable, "-m", "venv", str(VENV)]).returncode != 0:
            shutil.rmtree(VENV, ignore_errors=True)
            sys.exit("Could not create a venv. Is python3-venv installed?")
    if not marker.exists() or REQS.stat().st_mtime > marker.stat().st_mtime:
        print("Installing the EDL client's Python dependencies ...")
        for cmd in ([str(py), "-m", "pip", "install", "-q", "--upgrade", "pip"],
                    [str(py), "-m", "pip", "install", "-q", "-r", str(REQS)]):
            if subprocess.run(cmd).returncode != 0:
                sys.exit("Dependency install failed.")
        marker.touch()
    os.environ["EDL_SIDELOAD_REEXEC"] = "1"
    os.execv(str(py), [str(py), *sys.argv])


def ensure_usb_access(dev):
    node = usb_node(dev)
    if os.geteuid() == 0 or os.access(node, os.R_OK | os.W_OK):
        return
    if not shutil.which("sudo"):
        sys.exit(f"No write access to {node} and sudo is not installed. Run as root or add a udev rule for 05c6:9008.")
    print(f"No write access to {node}; re-running with sudo ...")
    os.execvp("sudo", ["sudo", sys.executable, *sys.argv])


def hand_back_to_user():
    uid, gid = os.environ.get("SUDO_UID"), os.environ.get("SUDO_GID")
    if os.geteuid() != 0 or not uid or not core.BACKUP_DIR.exists():
        return
    for p in [core.BACKUP_DIR, *core.BACKUP_DIR.iterdir()]:
        try:
            os.chown(p, int(uid), int(gid))
        except OSError:
            pass


def main():
    if not sys.platform.startswith("linux"):
        sys.exit("This helper is for Linux. On Windows use edl_sideload_windows.py.")

    ap = argparse.ArgumentParser(
        description="Write the --sideload request into misc over EDL (TCL Flip 4).")
    core.add_args(ap)
    args = ap.parse_args()
    core.check_args(args)

    ensure_deps()

    dev = find_edl_device()
    if dev is None:
        sys.exit("No Qualcomm 9008 device found. Power the phone off, hold Volume Up + Volume Down, and plug in USB while holding both keys.")
    print(f"9008 device present ({dev.name})")
    ensure_usb_access(dev)

    try:
        core.run_flow(args, lambda: find_edl_device() is not None)
    except KeyboardInterrupt:
        sys.exit("\nInterrupted.")
    finally:
        hand_back_to_user()


if __name__ == "__main__":
    main()
