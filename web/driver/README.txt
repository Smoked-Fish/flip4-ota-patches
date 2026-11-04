WinUSB driver for the TCL Flip 4 (T440W) in EDL mode

On Windows, Chromium-based browsers can only talk to a USB device that has the WinUSB driver, and the
phone in EDL mode (USB 05C6:9008) doesn't get one by itself. This puts it on, so the backup and restore
on the sideload page can reach the phone.

1. Unzip this folder.
2. Put the phone in EDL mode: off, then hold Volume Up + Volume Down while it starts. Plug it in.
3. Double-click install-edl-driver.bat and say yes to the administrator prompt.

It only touches the 05C6:9008 device. To undo it: Device Manager, find "TCL Flip 4 EDL" (with the phone in
EDL mode), Uninstall device, and tick "Attempt to remove the driver for this device".

wdi-simple.exe is from libwdi (https://github.com/pbatard/libwdi)
