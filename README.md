# TCL Flip 4 (T440W) — OTA + full backup

A self-signed A/B OTA for the TCL Flip 4 (T440W), plus the tools to take a full
eMMC backup of your phone before you flash it.

> **Back up first.** EDL and flashing can brick a phone. Take the backup in Step 2
> before you flash anything. You do this at your own risk.

The OTA installs to the inactive slot and
switches to it. Only flash it on a phone
running the build the OTA was made for.


---

## What's here

```
edlclient/               EDL client used for the backup
loader/flip-4-edl.bin    EDL firehose loader for the T440W
tools/wdi-simple.exe     Windows-only driver installer (see Step 2, Windows)
edl_backup_windows.py    one-command backup/restore on Windows
```
---

## 0. Check Build Version

Make sure the OTA is even for your phones build.


Go to **Settings → Device information**, then scroll down to **Build number**. 

If your build number is `7AC0UM00` you are good to go. You can get the ota patch in releases.



---

## 1. Turn on USB debugging

`adb reboot sideload` is sent from the running phone, so debugging has to be on.

1. Go to **Settings → Device information → More information**, then press:

   ```
   SoftLeft, SoftLeft, SoftRight, SoftLeft, SoftRight, SoftRight
   ```

   That reveals the Developer options menu.
2. Open **Developer** tab at the bottom of the Device page and set the Debugger option to **ADB**.
3. Plug the phone into the PC and run `adb devices`. Accept the prompt on the phone
   (tick "always allow"). It should show up as `device`.

You need `adb` for this and for Step 3:

- **Linux:** install `android-tools-adb` from your package manager, or unzip Google's
  [platform-tools](https://developer.android.com/tools/releases/platform-tools).
- **Windows:** run `winget install Google.PlatformTools` in powershell or unzip
  [platform-tools](https://developer.android.com/tools/releases/platform-tools) and
  run `adb` from that folder. If the phone isn't seen, install the
  [Google USB Driver](https://developer.android.com/studio/run/win-usb).

> If you still can't access developer options, you can go to **w2d.js.ord** in the phone browser and click the **Open Developer Menu** button.

---

## 2. Back up the phone **(DO NOT SKIP)**

This makes a complete raw copy of the phone's storage over EDL.If you do get stuck in a boot loop from a bad flash, the phone will automatically undo the flash so the risk is low but its not worth skipping this step.

### Enter EDL mode

1. Power the phone **off**.
2. Hold **Volume Up + Volume Down together** and keep holding while it starts up.
3. The screen should go white, if not follow the on screen instructions, this means the phone is in EDL mode. Plug it into the PC if it isn't already.

### Linux

Read the whole eMMC to a file:

```bash
python3 edlclient/edl.py rf flip4-full-emmc.img \
    --loader=loader/flip-4-edl.bin --memory=emmc --skipresponse
```

It takes roughly 15 minutes.

### Windows

EDL needs a libusb driver on the 9008 port. The included helper installs one, runs
the dump, and removes it again when it's done, so your normal driver setup is left
untouched.

From an **Administrator** terminal:

```bat
python edl_backup_windows.py
```

That writes `flip4-full-emmc.img` next to the script. Try adding `--driver libusbk` or `--driver winusb` if it doesn't work.

Use [`usbipd-win`](https://github.com/dorssel/usbipd-win) if you like WLS.

Hold **Power** to leave EDL.

---

## 3. Sideload the OTA

1. With the phone booted and debugging authorized:

   ```
   adb reboot sideload
   ```

   It reboots into sideload mode (`adb devices` now lists it as `sideload`). It will say it is waiting for a package.

2. Push the update:

   ```
   adb sideload ota.zip
   ```



3. Reboot. The first boot can take a bit
   longer than usual.

Since this is an A/B update it writes to the inactive slot, so a failed flash still
leaves you a bootable slot. After about 10 failed boots it will revert back to the bootable slot.

---

## 4. Restore, if you need to

Put the phone back in EDL (Step 2) and write your backup image back.

**Linux:**

```bash
python3 edlclient/edl.py wf flip4-full-emmc.img \
    --loader=loader/flip-4-edl.bin --memory=emmc
```

**Windows:**

```bat
python edl_backup_windows.py --write flip4-full-emmc.img
```

---

## Credits

- **[bkerler/edl](https://github.com/bkerler/edl)** — the EDL client in `edlclient/`.
   B. Kerler, licensed **GPLv3**.
- **[ambercaravalho/tcl-flip-4-root](https://github.com/ambercaravalho/tcl-flip-4-root)**
  — T440W backup groundwork and the firehose loader.
- **[libwdi / Zadig](https://github.com/pbatard/libwdi)** — `wdi-simple.exe`, used to
  bind the temporary Windows driver.

## License

The files original to this project, this README and `edl_backup_windows.py`, are under the MIT [`LICENSE`](./LICENSE.md).

Bundled third-party stuffs keep their own terms: `edlclient/` is **GPLv3**, and
`loader/flip-4-edl.bin` is proprietary Qualcomm/TCL vendor code.
