"""Hardware-free tests for the fixed root receiver-identity helper."""

from __future__ import annotations

import contextlib
import ctypes
import hashlib
import importlib.util
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("receiver_identity_helper", ROOT / "scripts/receiver-identity-helper.py")
assert SPEC and SPEC.loader
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def usb_descriptor(value: str) -> bytes:
    encoded = value.encode("utf-16le")
    return bytes((len(encoded) + 2, 3)) + encoded


def v4_image(serial: str = "OLD123") -> bytes:
    image = bytearray(helper.EEPROM_SIZE)
    image[0:2] = b"\x28\x32"
    image[6] = 0xA5
    offset = 9
    for value in (helper.BLOG_MANUFACTURER, helper.BLOG_PRODUCT, serial):
        descriptor = usb_descriptor(value)
        image[offset:offset + len(descriptor)] = descriptor
        offset += len(descriptor)
    image[128:144] = b"preserved-tail!!"
    return bytes(image)


class FakeRtlSdr:
    def __init__(self, image: bytes, serial: str = "OLD123") -> None:
        self.image = image
        self.devices = [(helper.BLOG_MANUFACTURER, helper.BLOG_PRODUCT, serial)]
        self.write_results: list[int] = []
        self.failed_prefix_lengths: list[int] = []
        self.partial_on_failure = True
        self.open_count = 0
        self.close_count = 0

    def rtlsdr_get_device_count(self) -> int:
        return len(self.devices)

    def rtlsdr_get_device_usb_strings(self, index, manufacturer, product, serial) -> int:
        values = self.devices[index]
        manufacturer.value = values[0].encode()
        product.value = values[1].encode()
        serial.value = values[2].encode()
        return 0

    def rtlsdr_open(self, out_device, index) -> int:
        ctypes.cast(out_device, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.c_void_p(index + 1)
        self.open_count += 1
        return 0

    def rtlsdr_close(self, _device) -> int:
        self.close_count += 1
        return 0

    def rtlsdr_read_eeprom(self, _device, buffer, _offset, length) -> int:
        ctypes.memmove(buffer, self.image, length)
        return 0

    def rtlsdr_write_eeprom(self, _device, buffer, _offset, length) -> int:
        incoming = bytes(buffer[:length])
        result = self.write_results.pop(0) if self.write_results else 0
        if result == 0:
            self.image = incoming
        elif self.partial_on_failure:
            # Include the serial descriptor in the partial write to model a torn update.
            prefix = self.failed_prefix_lengths.pop(0) if self.failed_prefix_lengths else 54
            self.image = incoming[:prefix] + self.image[prefix:]
        return result


class ReceiverIdentityHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.state_dir = root / "state"
        self.config_dir = root / "ais-config"
        self.config_dir.mkdir(mode=0o750)
        os.chmod(self.config_dir, 0o750)
        self.config_path = self.config_dir / "aiscatcher.json"
        self.config_data = {
            "receiver": [{"input": "RTLSDR", "serial": "OLD123", "gain": 31.2}],
            "web": {"port": 8100, "enabled": True},
            "unrelated": [1, "keep me"],
        }
        self.config_path.write_text(json.dumps(self.config_data, indent=2) + "\n", encoding="utf-8")
        os.chmod(self.config_path, 0o640)
        self.original = v4_image()
        self.new_image = helper.patch_serial(self.original, "BOATSDR01")
        self.rtl = FakeRtlSdr(self.original)
        self.fchown_calls: list[tuple[int, int]] = []
        self.patches = [
            mock.patch.multiple(
                helper,
                AIS_CONFIG=self.config_path,
                STATE_DIR=self.state_dir,
                JOURNAL=self.state_dir / "journal.json",
                LOCK=self.state_dir / "lock",
            ),
            # Temp files inherit the current test user's ownership, which is what the
            # ownership-preservation checks below expect for these fixtures.
            mock.patch.object(helper.os, "fchown", lambda _fd, uid, gid: self.fchown_calls.append((uid, gid))),
            mock.patch.object(helper, "rtl_library", return_value=self.rtl),
            mock.patch.object(helper, "require_ais_stopped", return_value=None),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def save_writing_journal(self, image: bytes | None = None) -> dict:
        backup_path = self.state_dir / "eeprom.before-test.bin"
        backup_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup_path.write_bytes(self.original)
        journal = {
            "version": 1,
            "phase": "writing",
            "oldSerial": "OLD123",
            "newSerial": "BOATSDR01",
            "eepromBackup": str(backup_path),
            "oldEepromSha256": hashlib.sha256(self.original).hexdigest(),
            "newEepromSha256": hashlib.sha256(self.new_image).hexdigest(),
        }
        helper.save_journal(journal)
        return journal

    def test_blog_v4_serial_capacity_and_patch_preserve_unrelated_eeprom_bytes(self) -> None:
        capacity = helper.serial_capacity(self.original)
        self.assertEqual(capacity, 14)
        updated = helper.patch_serial(self.original, "BOATSDR01")
        self.assertEqual(helper.eeprom_serial(updated), "BOATSDR01")
        self.assertEqual(updated[:9], self.original[:9])
        self.assertEqual(updated[128:], self.original[128:])
        self.assertEqual(updated[:47], self.original[:47], "manufacturer and product descriptors stay intact")
        self.assertEqual(self.rtl.rtlsdr_get_device_count(), 1)
        self.assertEqual(helper.device_inventory(self.rtl)[0]["maxSerialLength"], capacity)
        with self.assertRaisesRegex(helper.IdentityError, "maximum 14"):
            helper.patch_serial(self.original, "A12345678901234")

    def test_malformed_header_descriptor_and_serial_are_refused(self) -> None:
        bad_header = bytearray(self.original)
        bad_header[0] = 0
        with self.assertRaisesRegex(helper.IdentityError, "header"):
            helper.serial_capacity(bytes(bad_header))
        bad_descriptor = bytearray(self.original)
        bad_descriptor[47] |= 1
        with self.assertRaisesRegex(helper.IdentityError, "invalid USB string descriptor"):
            helper.eeprom_serial(bytes(bad_descriptor))
        for serial in ("1BOAT", "AB", "BOAT SPACE", "A" * 17):
            with self.subTest(serial=serial), self.assertRaises(helper.IdentityError):
                helper.patch_serial(self.original, serial)

    def test_one_device_refuses_multiple_receivers(self) -> None:
        self.rtl.devices.append((helper.BLOG_MANUFACTURER, helper.BLOG_PRODUCT, "OTHER1"))
        with self.assertRaisesRegex(helper.IdentityError, "exactly one attached RTL-SDR"):
            helper.one_device(self.rtl)
        self.assertEqual(self.rtl.open_count, 0)

    def test_serial_change_waits_for_reconnect_then_updates_only_ais_serial(self) -> None:
        phase = helper.begin({"action": "begin", "currentSerial": "OLD123", "serial": "BOATSDR01"})
        self.assertEqual(phase["phase"], "pendingReconnect")
        self.assertEqual(self.rtl.image, self.new_image)
        self.assertEqual(helper.config_serial(json.loads(self.config_path.read_bytes())), "OLD123")
        journal = helper.read_journal()
        self.assertTrue(Path(journal["eepromBackup"]).exists())
        self.assertTrue(Path(journal["configBackup"]).exists())

        self.rtl.devices[0] = (helper.BLOG_MANUFACTURER, helper.BLOG_PRODUCT, "BOATSDR01")
        finalized = helper.finalize()
        self.assertEqual(finalized["phase"], "configUpdated")
        updated = json.loads(self.config_path.read_bytes())
        self.assertEqual(updated["receiver"][0]["serial"], "BOATSDR01")
        self.assertEqual(updated["receiver"][0]["gain"], 31.2)
        self.assertEqual(updated["web"], self.config_data["web"])
        self.assertEqual(updated["unrelated"], self.config_data["unrelated"])
        self.assertEqual(helper.handle({"action": "complete"})["phase"], "complete")

    def test_factory_numeric_serial_is_valid_as_the_current_identity(self) -> None:
        factory_image = v4_image("00000001")
        self.rtl.image = factory_image
        self.rtl.devices[0] = (helper.BLOG_MANUFACTURER, helper.BLOG_PRODUCT, "00000001")
        self.config_data["receiver"][0]["serial"] = "00000001"
        self.config_path.write_text(json.dumps(self.config_data), encoding="utf-8")
        result = helper.begin({"action": "begin", "currentSerial": "00000001", "serial": "BOATSDR01"})
        self.assertEqual(result["phase"], "pendingReconnect")
        self.assertEqual(helper.eeprom_serial(self.rtl.image), "BOATSDR01")

    def test_config_replacement_preserves_mode_owner_and_parent_directory_permissions(self) -> None:
        before = self.config_path.stat()
        parent_mode = stat.S_IMODE(self.config_dir.stat().st_mode)
        backup_path = helper.replace_ais_config("OLD123", "BOATSDR01")
        after = self.config_path.stat()
        self.assertEqual(stat.S_IMODE(after.st_mode), stat.S_IMODE(before.st_mode))
        self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))
        self.assertIn((before.st_uid, before.st_gid), self.fchown_calls)
        self.assertEqual(stat.S_IMODE(self.config_dir.stat().st_mode), parent_mode)
        self.assertEqual(json.loads(self.config_path.read_bytes())["receiver"][0]["serial"], "BOATSDR01")
        self.assertEqual(json.loads(backup_path.read_bytes()), self.config_data)
        self.assertEqual(stat.S_IMODE(backup_path.stat().st_mode), 0o600)

    def test_config_symlink_is_refused_without_replacing_link_or_target(self) -> None:
        target = self.config_dir / "real-config.json"
        target.write_bytes(self.config_path.read_bytes())
        link = self.config_dir / "linked-config.json"
        link.symlink_to(target.name)
        with mock.patch.object(helper, "AIS_CONFIG", link):
            with self.assertRaisesRegex(helper.IdentityError, "regular file, not a symlink"):
                helper.config_snapshot()
        self.assertTrue(link.is_symlink())
        self.assertEqual(json.loads(target.read_bytes()), self.config_data)

    def test_receiver_journal_and_state_directory_symlinks_are_refused(self) -> None:
        self.state_dir.mkdir(mode=0o700)
        target = self.state_dir / "journal-target.json"
        target.write_text('{"version":1,"phase":"idle"}', encoding="utf-8")
        journal_link = self.state_dir / "journal.json"
        journal_link.symlink_to(target.name)
        with self.assertRaisesRegex(helper.IdentityError, "state file is unsafe"):
            helper.read_journal()
        unsafe_dir = self.config_dir / "state-link"
        unsafe_dir.symlink_to(self.state_dir, target_is_directory=True)
        with self.assertRaisesRegex(helper.IdentityError, "state directory is unsafe"):
            helper.validate_state_directory(unsafe_dir)

    def test_external_receiver_selection_change_is_not_overwritten(self) -> None:
        changed = {"receiver": [{"input": "RTLSDR", "serial": "OTHER1"}]}
        self.config_path.write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(helper.IdentityError, "changed externally"):
            helper.replace_ais_config("OLD123", "BOATSDR01")
        self.assertEqual(json.loads(self.config_path.read_bytes()), changed)
        self.assertEqual(self.rtl.open_count, 0)

    def test_failed_eeprom_write_restores_and_verifies_original_image(self) -> None:
        self.rtl.write_results = [-1, 0]
        with self.assertRaisesRegex(helper.IdentityError, "original image was restored"):
            helper.begin({"action": "begin", "currentSerial": "OLD123", "serial": "BOATSDR01"})
        self.assertEqual(self.rtl.image, self.original)
        journal = helper.read_journal()
        self.assertEqual(journal["phase"], "error")
        self.assertIs(journal["failClosed"], False)

    def test_uncertain_eeprom_rollback_fails_closed(self) -> None:
        self.rtl.write_results = [-1, -1]
        self.rtl.failed_prefix_lengths = [54, 53]
        with self.assertRaisesRegex(helper.IdentityError, "write/rollback uncertain"):
            helper.begin({"action": "begin", "currentSerial": "OLD123", "serial": "BOATSDR01"})
        self.assertNotEqual(self.rtl.image, self.original)
        journal = helper.read_journal()
        self.assertEqual(journal["phase"], "error")
        self.assertIs(journal["failClosed"], True)

    def test_interrupted_write_recovers_full_new_image_for_reconnect(self) -> None:
        self.save_writing_journal()
        self.rtl.image = self.new_image
        result = helper.recover()
        self.assertEqual(result["phase"], "pendingReconnect")
        self.assertEqual(self.rtl.image, self.new_image)
        self.assertTrue(helper.read_journal().get("failClosed", False), "old USB identity keeps both receivers paused until unplug/replug")
        self.rtl.devices[0] = (helper.BLOG_MANUFACTURER, helper.BLOG_PRODUCT, "BOATSDR01")
        finalized = helper.finalize()
        self.assertEqual(finalized["phase"], "configUpdated")
        self.assertFalse(finalized.get("failClosed", False))

    def test_interrupted_write_with_old_usb_and_old_image_is_retryable(self) -> None:
        self.save_writing_journal()
        result = helper.recover()
        self.assertEqual(result["phase"], "error")
        self.assertIs(result.get("failClosed"), False)
        self.assertEqual(self.rtl.image, self.original)

    def test_interrupted_write_restores_partial_image_and_keeps_receiver_gated(self) -> None:
        self.save_writing_journal()
        self.rtl.image = self.new_image[:54] + self.original[54:]
        result = helper.recover()
        self.assertEqual(result["phase"], "error")
        self.assertEqual(self.rtl.image, self.original)
        self.assertIs(helper.read_journal().get("failClosed"), False)

    def test_old_eeprom_with_new_usb_identity_remains_fail_closed(self) -> None:
        self.save_writing_journal()
        self.rtl.devices[0] = (helper.BLOG_MANUFACTURER, helper.BLOG_PRODUCT, "BOATSDR01")
        self.rtl.image = self.original
        result = helper.recover()
        self.assertEqual(result["phase"], "error")
        self.assertIs(result.get("failClosed"), True)
        self.assertEqual(self.rtl.image, self.original)

    def test_helper_rejects_extra_json_fields_and_unexpected_command_arguments(self) -> None:
        with self.assertRaisesRegex(helper.IdentityError, "Invalid receiver identity request"):
            helper.handle({"action": "status", "extra": True})
        output = io.StringIO()
        with mock.patch.object(helper.os, "geteuid", return_value=0), mock.patch.object(helper.sys, "argv", ["receiver-identity-helper.py", "unexpected"]), contextlib.redirect_stdout(output):
            result = helper.main()
        self.assertEqual(result, 2)
        self.assertEqual(json.loads(output.getvalue())["error"], "This fixed helper must run as root without arguments")


if __name__ == "__main__":
    unittest.main(verbosity=2)
