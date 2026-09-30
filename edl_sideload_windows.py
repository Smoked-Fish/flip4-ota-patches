#!/usr/bin/env python3
"""
python edl_sideload_windows.py               # then: adb sideload ota.zip
python edl_sideload_windows.py --dry-run     # read only, shows what would change
"""

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import edl_backup_windows as base
import edl_sideload_core as core

LIBUSB_CLASSES = ("libusb", "usbdevice")   # device classes edl.py can talk to over libusb


def edl_device_class():
    ps = ("(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\VID_05C6&PID_9008*' } | Select-Object -First 1).Class")
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                         capture_output=True, text=True).stdout.strip()
    return out or None


def main():
    if sys.platform != "win32":
        sys.exit("This helper is for Windows. On Linux use edl_sideload_linux.py.")

    ap = argparse.ArgumentParser(
        description="Write the --sideload request into misc over EDL (TCL Flip 4).")
    core.add_args(ap)
    ap.add_argument("--wdi", type=Path, default=base.DEFAULT_WDI)
    ap.add_argument("--driver", choices=base.DRIVERS, default="libusb0", help="libusb driver to bind if none is bound yet (default: libusb0)")
    args = ap.parse_args()
    core.check_args(args)

    cls = edl_device_class()
    if cls is None:
        sys.exit("No Qualcomm 9008 device found. Power the phone off, hold Volume Up + Volume Down, and plug in USB while holding both keys.")
    driver_ready = any(k in cls.lower() for k in LIBUSB_CLASSES)
    print(f"9008 device present, driver class: {cls} (already usable, leaving the driver alone)" if driver_ready else "")

    if not driver_ready and not base.is_admin():
        base.relaunch_as_admin()
    base.ensure_deps(args.edl)

    before = set() if driver_ready else base.oem_infs()
    try:
        if not driver_ready:
            base.install_driver(args.wdi, args.driver)
        core.run_flow(args, lambda: edl_device_class() is not None)
    except KeyboardInterrupt:
        sys.exit("\nInterrupted.")
    finally:
        if not driver_ready:
            print("\nRemoving the temporary driver...")
            base.remove_driver(base.oem_infs() - before)


if __name__ == "__main__":
    main()
