#!/usr/bin/python3 -I
"""Root-owned, fixed-path RTL-SDR identity and AIS-Catcher config helper."""

from __future__ import annotations

import ctypes
import ctypes.util
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

AIS_CONFIG = Path("/etc/AIS-catcher/aiscatcher.json")
STATE_DIR = Path("/var/lib/signalk-vhf-watch/receiver-identity")
JOURNAL = STATE_DIR / "journal.json"
LOCK = STATE_DIR / "lock"
AIS_UNIT = "ais-catcher.service"
BLOG_MANUFACTURER = "RTLSDRBlog"
BLOG_PRODUCT = "Blog V4"
SERIAL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{2,15}$")
CURRENT_SERIAL_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
EEPROM_SIZE = 256
DESCRIPTOR_LIMIT = 78
USB_PATH = "/usr/bin/systemctl"


class IdentityError(Exception):
    pass


def atomic_bytes(path: Path, content: bytes, mode: int, uid: int = 0, gid: int = 0) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".receiver-identity-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def save_journal(journal: dict) -> None:
    validate_state_file(JOURNAL)
    atomic_bytes(JOURNAL, (json.dumps(journal, sort_keys=True) + "\n").encode(), 0o600)


def validate_state_directory(path: Path, create: bool = False) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        if not create:
            raise IdentityError(f"Receiver identity state directory is missing: {path}")
        os.mkdir(path, 0o700)
        info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise IdentityError(f"Receiver identity state directory is unsafe: {path}")
    if path == STATE_DIR and stat.S_IMODE(info.st_mode) != 0o700:
        os.chmod(path, 0o700)


def validate_state_file(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise IdentityError(f"Receiver identity state file is unsafe: {path}")


def read_journal() -> dict | None:
    try:
        validate_state_file(JOURNAL)
        value = json.loads(JOURNAL.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    if not isinstance(value, dict) or value.get("version") != 1:
        raise IdentityError("Receiver identity journal is invalid; receiver remains paused")
    return value


def with_lock():
    validate_state_directory(Path("/var/lib"))
    validate_state_directory(STATE_DIR.parent, create=True)
    validate_state_directory(STATE_DIR, create=True)
    validate_state_file(LOCK)
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(LOCK, flags, 0o600)
    os.fchmod(descriptor, 0o600)
    stream = os.fdopen(descriptor, "a+b")
    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    return stream


def require_ais_stopped() -> None:
    result = subprocess.run([USB_PATH, "is-active", AIS_UNIT], capture_output=True, text=True, timeout=5)
    if result.returncode == 0 and result.stdout.strip() == "active":
        raise IdentityError("AIS-Catcher must be stopped before accessing the SDR")
    if result.returncode not in (0, 3) and result.stdout.strip() not in ("inactive", "failed"):
        raise IdentityError("Could not verify that AIS-Catcher is stopped")


def rtl_library():
    name = ctypes.util.find_library("rtlsdr")
    if not name:
        raise IdentityError("librtlsdr is unavailable")
    lib = ctypes.CDLL(name)
    lib.rtlsdr_get_device_count.restype = ctypes.c_uint32
    lib.rtlsdr_get_device_usb_strings.argtypes = [ctypes.c_uint32, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
    lib.rtlsdr_get_device_usb_strings.restype = ctypes.c_int
    lib.rtlsdr_open.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint32]
    lib.rtlsdr_open.restype = ctypes.c_int
    lib.rtlsdr_close.argtypes = [ctypes.c_void_p]
    lib.rtlsdr_close.restype = ctypes.c_int
    lib.rtlsdr_read_eeprom.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint8, ctypes.c_uint16]
    lib.rtlsdr_read_eeprom.restype = ctypes.c_int
    lib.rtlsdr_write_eeprom.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint8, ctypes.c_uint16]
    lib.rtlsdr_write_eeprom.restype = ctypes.c_int
    return lib


def device_inventory(lib) -> list[dict[str, str]]:
    count = int(lib.rtlsdr_get_device_count())
    devices: list[dict[str, str]] = []
    for index in range(count):
        manufacturer, product, serial = ctypes.create_string_buffer(256), ctypes.create_string_buffer(256), ctypes.create_string_buffer(256)
        result = lib.rtlsdr_get_device_usb_strings(index, manufacturer, product, serial)
        if result != 0:
            raise IdentityError("Could not read RTL-SDR USB identity")
        vendor = manufacturer.value.decode("utf-8", "strict")
        model = product.value.decode("utf-8", "strict")
        serial_text = serial.value.decode("utf-8", "strict")
        device = {
            "index": index,
            "manufacturer": vendor,
            "product": model,
            "serial": serial_text,
        }
        if vendor == BLOG_MANUFACTURER and model == BLOG_PRODUCT:
            serial_start = 9 + (2 + 2 * len(vendor)) + (2 + 2 * len(model))
            device["maxSerialLength"] = max(0, (DESCRIPTOR_LIMIT - serial_start - 2) // 2)
        devices.append(device)
    return devices


def open_device(lib, index: int):
    device = ctypes.c_void_p()
    if lib.rtlsdr_open(ctypes.byref(device), index) != 0:
        raise IdentityError("Could not open the selected RTL-SDR")
    return device


def read_eeprom(lib, device) -> bytes:
    buffer = (ctypes.c_uint8 * EEPROM_SIZE)()
    result = lib.rtlsdr_read_eeprom(device, buffer, 0, EEPROM_SIZE)
    if result < 0:
        raise IdentityError(f"Could not read RTL-SDR EEPROM (error {result})")
    return bytes(buffer)


def write_eeprom(lib, device, image: bytes) -> None:
    if len(image) != EEPROM_SIZE:
        raise IdentityError("Invalid EEPROM image length")
    buffer = (ctypes.c_uint8 * EEPROM_SIZE).from_buffer_copy(image)
    result = lib.rtlsdr_write_eeprom(device, buffer, 0, EEPROM_SIZE)
    if result != 0:
        raise IdentityError(f"Could not write RTL-SDR EEPROM (error {result})")


def read_descriptors(image: bytes) -> tuple[list[tuple[int, int, str]], int]:
    if len(image) != EEPROM_SIZE or image[0:2] != b"\x28\x32":
        raise IdentityError("Unsupported RTL-SDR EEPROM header")
    descriptors = []
    position = 9
    for _ in range(3):
        if position + 2 > DESCRIPTOR_LIMIT:
            raise IdentityError("RTL-SDR string descriptors exceed the supported layout")
        length = image[position]
        if length < 2 or length % 2 or image[position + 1] != 3 or position + length > DESCRIPTOR_LIMIT:
            raise IdentityError("RTL-SDR EEPROM has an invalid USB string descriptor")
        try:
            value = image[position + 2:position + length].decode("utf-16le", "strict")
        except UnicodeDecodeError as error:
            raise IdentityError("RTL-SDR EEPROM contains an invalid USB string") from error
        descriptors.append((position, length, value))
        position += length
    return descriptors, position


def serial_capacity(image: bytes) -> int:
    descriptors, end = read_descriptors(image)
    if descriptors[0][2] != BLOG_MANUFACTURER or descriptors[1][2] != BLOG_PRODUCT:
        raise IdentityError("Expected an RTL-SDR Blog V4; manufacturer/product strings must be preserved")
    if image[6] != 0xA5:
        raise IdentityError("The SDR does not have an enabled serial descriptor")
    # Descriptor 3 may grow only into the remaining defined descriptor area.
    return max(0, (DESCRIPTOR_LIMIT - end + descriptors[2][1] - 2) // 2)


def eeprom_serial(image: bytes) -> str:
    descriptors, _ = read_descriptors(image)
    if descriptors[0][2] != BLOG_MANUFACTURER or descriptors[1][2] != BLOG_PRODUCT:
        raise IdentityError("Expected an RTL-SDR Blog V4; manufacturer/product strings must be preserved")
    if image[6] != 0xA5:
        raise IdentityError("The SDR does not have an enabled serial descriptor")
    return descriptors[2][2]


def patch_serial(image: bytes, serial: str) -> bytes:
    if not isinstance(serial, str) or not SERIAL_RE.fullmatch(serial):
        raise IdentityError("Serial must start with a letter and use 3–16 letters, digits, underscores, or hyphens")
    descriptors, _ = read_descriptors(image)
    if descriptors[0][2] != BLOG_MANUFACTURER or descriptors[1][2] != BLOG_PRODUCT:
        raise IdentityError("Expected an RTL-SDR Blog V4; manufacturer/product strings must be preserved")
    if image[6] != 0xA5:
        raise IdentityError("The SDR does not have an enabled serial descriptor")
    position, old_length, _ = descriptors[2]
    encoded = serial.encode("utf-16le")
    descriptor_length = len(encoded) + 2
    if position + descriptor_length > DESCRIPTOR_LIMIT:
        raise IdentityError(f"Serial is too long for this V4 EEPROM (maximum {serial_capacity(image)} characters)")
    # RTL-SDR Blog may leave stale text in the unused string-descriptor area.
    # Growth is bounded by DESCRIPTOR_LIMIT and changes only the old/new serial span.
    updated = bytearray(image)
    updated[position] = descriptor_length
    updated[position + 1] = 3
    updated[position + 2:position + descriptor_length] = encoded
    for offset in range(position + descriptor_length, position + old_length):
        updated[offset] = 0
    # Bytes outside the old/new serial descriptor union remain exactly as read.
    return bytes(updated)


def config_serial(document: dict) -> str:
    receivers = document.get("receiver") if isinstance(document, dict) else None
    if not isinstance(receivers, list) or len(receivers) != 1 or not isinstance(receivers[0], dict):
        raise IdentityError("AIS-Catcher must have exactly one configured receiver")
    receiver = receivers[0]
    if receiver.get("input") != "RTLSDR" or not isinstance(receiver.get("serial"), str):
        raise IdentityError("AIS-Catcher receiver[0] is not a serial-selected RTLSDR")
    return receiver["serial"]


def config_snapshot() -> tuple[bytes, os.stat_result, dict]:
    try:
        info = AIS_CONFIG.lstat()
    except OSError as error:
        raise IdentityError("AIS-Catcher configuration is unavailable") from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise IdentityError("AIS-Catcher configuration must be a regular file, not a symlink")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(AIS_CONFIG, flags)
        with os.fdopen(fd, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise IdentityError("AIS-Catcher configuration changed while being read")
            content = stream.read()
    except OSError as error:
        raise IdentityError("AIS-Catcher configuration changed while being read") from error
    try:
        document = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IdentityError("AIS-Catcher configuration is invalid JSON") from error
    if not isinstance(document, dict):
        raise IdentityError("AIS-Catcher configuration must be an object")
    return content, info, document


def backup(path: Path, content: bytes) -> None:
    if not path.exists():
        atomic_bytes(path, content, 0o600)


def replace_ais_config(expected_serial: str, new_serial: str) -> Path:
    current, info, latest = config_snapshot()
    if config_serial(latest) != expected_serial:
        raise IdentityError("AIS-Catcher receiver selection changed externally; refusing to overwrite it")
    current_hash = hashlib.sha256(current).hexdigest()
    backup_path = STATE_DIR / f"aiscatcher.before-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{current_hash[:10]}.json"
    backup(backup_path, current)
    latest["receiver"][0]["serial"] = new_serial
    updated = (json.dumps(latest, indent=2, ensure_ascii=False) + "\n").encode()
    # Verify the source did not change after the optimistic read and before atomic replacement.
    latest_info = AIS_CONFIG.lstat()
    if stat.S_ISLNK(latest_info.st_mode) or not stat.S_ISREG(latest_info.st_mode) or (latest_info.st_dev, latest_info.st_ino) != (info.st_dev, info.st_ino):
        raise IdentityError("AIS-Catcher configuration changed during identity update; retry to preserve the newer file")
    if hashlib.sha256(AIS_CONFIG.read_bytes()).hexdigest() != current_hash:
        raise IdentityError("AIS-Catcher configuration changed during identity update; retry to preserve the newer file")
    atomic_bytes(AIS_CONFIG, updated, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
    return backup_path


def one_device(lib, expected_serial: str | None = None) -> dict[str, str]:
    devices = device_inventory(lib)
    if len(devices) != 1:
        raise IdentityError(f"Expected exactly one attached RTL-SDR; found {len(devices)}")
    device = devices[0]
    if device["manufacturer"] != BLOG_MANUFACTURER or device["product"] != BLOG_PRODUCT:
        raise IdentityError("Expected exactly one RTL-SDR Blog V4")
    if expected_serial is not None and device["serial"] != expected_serial:
        raise IdentityError(f"Attached SDR serial is {device['serial']!r}, expected {expected_serial!r}")
    return device


def begin(request: dict) -> dict:
    current, new = request.get("currentSerial"), request.get("serial")
    if not isinstance(current, str) or not CURRENT_SERIAL_RE.fullmatch(current):
        raise IdentityError("Current serial is invalid")
    if not isinstance(new, str) or not SERIAL_RE.fullmatch(new):
        raise IdentityError("Serial must start with a letter and use 3–16 letters, digits, underscores, or hyphens")
    if current == new:
        raise IdentityError("The new serial is already assigned")
    existing = read_journal()
    if existing:
        if existing.get("phase") not in ("complete", "error"):
            raise IdentityError("A receiver identity change is already pending")
        if existing.get("phase") == "error" and existing.get("failClosed"):
            raise IdentityError("An unsafe receiver identity journal must be reconciled before another change")
    require_ais_stopped()
    content, info, document = config_snapshot()
    if config_serial(document) != current:
        raise IdentityError("AIS-Catcher serial changed; reload status before retrying")
    lib = rtl_library()
    device_info = one_device(lib, current)
    opened = open_device(lib, device_info["index"])
    try:
        image = read_eeprom(lib, opened)
        if eeprom_serial(image) != current:
            raise IdentityError("EEPROM serial does not match the selected USB device")
        updated = patch_serial(image, new)
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        eeprom_backup = STATE_DIR / f"eeprom.before-{stamp}.bin"
        config_backup = STATE_DIR / f"aiscatcher.before-{stamp}.json"
        atomic_bytes(eeprom_backup, image, 0o600)
        atomic_bytes(config_backup, content, 0o600)
        journal = {
            "version": 1,
            "phase": "writing",
            "oldSerial": current,
            "newSerial": new,
            "eepromBackup": str(eeprom_backup),
            "configBackup": str(config_backup),
            "configMode": stat.S_IMODE(info.st_mode),
            "configUid": info.st_uid,
            "configGid": info.st_gid,
            "oldEepromSha256": hashlib.sha256(image).hexdigest(),
            "newEepromSha256": hashlib.sha256(updated).hexdigest(),
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        save_journal(journal)
        try:
            write_eeprom(lib, opened, updated)
            verified = read_eeprom(lib, opened)
            if verified != updated:
                raise IdentityError("EEPROM readback did not match the requested serial")
        except Exception as error:
            try:
                write_eeprom(lib, opened, image)
                if read_eeprom(lib, opened) != image:
                    raise IdentityError("EEPROM rollback verification failed")
                usb_after = device_inventory(lib)
                usb_old = len(usb_after) == 1 and usb_after[0]["serial"] == current
                journal.update({
                    "phase": "error",
                    "error": "EEPROM write failed and the original image was restored" + ("; reconnect the SDR before retrying" if not usb_old else ""),
                    "failClosed": not usb_old,
                })
            except Exception as rollback_error:
                journal.update({"phase": "error", "error": f"EEPROM write/rollback uncertain: {rollback_error}", "failClosed": True})
            save_journal(journal)
            raise IdentityError(journal["error"]) from error
        journal.update({"phase": "pendingReconnect", "error": None})
        save_journal(journal)
        return summarize(journal)
    finally:
        lib.rtlsdr_close(opened)


def finalize() -> dict:
    journal = read_journal()
    if not journal or journal.get("phase") not in ("pendingReconnect", "configUpdated"):
        raise IdentityError("No receiver identity change is ready to finalize")
    require_ais_stopped()
    lib = rtl_library()
    device_info = one_device(lib, journal["newSerial"])
    opened = open_device(lib, device_info["index"])
    try:
        image = read_eeprom(lib, opened)
        backup_path = Path(journal["eepromBackup"])
        if backup_path.parent != STATE_DIR:
            raise IdentityError("EEPROM backup path is invalid")
        original = backup_path.read_bytes()
        expected = patch_serial(original, journal["newSerial"])
        if hashlib.sha256(expected).hexdigest() != journal.get("newEepromSha256") or image != expected:
            raise IdentityError("Reconnected SDR EEPROM does not contain the requested serial")
    finally:
        lib.rtlsdr_close(opened)
    if journal["phase"] == "pendingReconnect":
        _, _, document = config_snapshot()
        serial = config_serial(document)
        if serial not in (journal["oldSerial"], journal["newSerial"]):
            raise IdentityError("AIS-Catcher receiver selection changed externally; refusing to overwrite it")
        backup_path = replace_ais_config(journal["oldSerial"], journal["newSerial"]) if serial == journal["oldSerial"] else None
        if serial == journal["oldSerial"]:
            journal["configBackupFinal"] = str(backup_path) if backup_path else None
        journal.update({"phase": "configUpdated", "error": None, "failClosed": False})
    elif journal.get("failClosed"):
        journal.update({"failClosed": False})
    save_journal(journal)
    return summarize(journal)


def recover() -> dict:
    journal = read_journal()
    if not journal or (journal.get("phase") != "writing" and not (journal.get("phase") == "error" and journal.get("failClosed"))):
        return summarize(journal)
    try:
        require_ais_stopped()
        lib = rtl_library()
        devices = device_inventory(lib)
        if len(devices) != 1 or devices[0]["manufacturer"] != BLOG_MANUFACTURER or devices[0]["product"] != BLOG_PRODUCT:
            return summarize(journal)
        backup_path = Path(journal["eepromBackup"])
        if backup_path.parent != STATE_DIR:
            raise IdentityError("EEPROM backup path is invalid")
        original = backup_path.read_bytes()
        if len(original) != EEPROM_SIZE or hashlib.sha256(original).hexdigest() != journal.get("oldEepromSha256"):
            raise IdentityError("EEPROM backup is missing or damaged")
        target = patch_serial(original, journal["newSerial"])
        opened = open_device(lib, devices[0]["index"])
        try:
            current = read_eeprom(lib, opened)
            usb_serial = devices[0]["serial"]
            if current == target and usb_serial == journal.get("newSerial"):
                journal.update({"phase": "pendingReconnect", "error": None})
            elif current == target:
                journal.update({"phase": "pendingReconnect", "error": "EEPROM is updated; reconnect the SDR to apply its new USB serial", "failClosed": True})
            elif current == original and usb_serial == journal.get("oldSerial"):
                journal.update({"phase": "error", "error": "The original EEPROM is intact; retry the rename", "failClosed": False})
            elif current == original:
                journal.update({"phase": "error", "error": "The original EEPROM is intact; reconnect the SDR before retrying", "failClosed": True})
            else:
                try:
                    write_eeprom(lib, opened, original)
                    if read_eeprom(lib, opened) != original:
                        raise IdentityError("EEPROM rollback verification failed")
                    usb_after = device_inventory(lib)
                    usb_old = len(usb_after) == 1 and usb_after[0]["serial"] == journal.get("oldSerial")
                    journal.update({
                        "phase": "error",
                        "error": "An interrupted EEPROM write was rolled back" + ("; reconnect the SDR before retrying" if not usb_old else "; retry the rename"),
                        "failClosed": not usb_old,
                    })
                except Exception as rollback_error:
                    journal.update({"phase": "error", "error": f"EEPROM state is uncertain after interrupted write: {rollback_error}", "failClosed": True})
        finally:
            lib.rtlsdr_close(opened)
        save_journal(journal)
    except Exception:
        # A missing or unreadable device is not proof that the EEPROM write did not occur.
        return summarize(journal)
    return summarize(journal)


def summarize(journal: dict | None) -> dict:
    if journal is None:
        return {"phase": "idle"}
    keys = ("phase", "oldSerial", "newSerial", "startedAt", "error", "failClosed")
    return {key: journal[key] for key in keys if key in journal}


def handle(request: dict) -> dict:
    action = request.get("action")
    if action == "status" and set(request) == {"action"}:
        result = summarize(read_journal())
        try:
            _, _, document = config_snapshot()
            result["aisSerial"] = config_serial(document)
        except Exception as error:
            result["aisError"] = str(error)
        return result
    if action == "inventory" and set(request) == {"action"}:
        lib = rtl_library()
        devices = device_inventory(lib)
        return {"devices": devices}
    if action == "begin" and set(request) == {"action", "currentSerial", "serial"}:
        return begin(request)
    if action == "finalize" and set(request) == {"action"}:
        return finalize()
    if action == "recover" and set(request) == {"action"}:
        return recover()
    if action == "complete" and set(request) == {"action"}:
        journal = read_journal()
        if not journal or journal.get("phase") not in ("configUpdated", "complete"):
            raise IdentityError("Receiver identity configuration has not been verified")
        if journal.get("phase") == "complete":
            return summarize(journal)
        journal.update({"phase": "complete", "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        save_journal(journal)
        return summarize(journal)
    raise IdentityError("Invalid receiver identity request")


def main() -> int:
    if os.geteuid() != 0 or len(sys.argv) != 1:
        print(json.dumps({"error": "This fixed helper must run as root without arguments"}))
        return 2
    signal.alarm(15)
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise IdentityError("Request is too large")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise IdentityError("Request must be a JSON object")
        with with_lock():
            result = handle(request)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        return 0
    except Exception as error:
        journal = None
        try:
            journal = read_journal()
        except Exception:
            pass
        output = {"ok": False, "error": str(error)}
        if journal:
            output["phase"] = journal.get("phase")
            output["failClosed"] = journal.get("failClosed", journal.get("phase") in ("writing", "pendingReconnect", "configUpdated"))
            output["oldSerial"] = journal.get("oldSerial")
            output["newSerial"] = journal.get("newSerial")
        print(json.dumps(output, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
