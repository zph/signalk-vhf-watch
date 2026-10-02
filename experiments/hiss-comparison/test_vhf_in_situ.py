import unittest
from unittest.mock import patch

import run_vhf_in_situ as trial
import analyze_vhf_waveforms as waveform_analysis


class InSituHelpersTest(unittest.TestCase):
    def test_requested_ids_are_resolved_in_requested_order_without_network(self):
        records = [
            {"id": 829, "durationSeconds": 21.38, "channel": "80A"},
            {"id": 819, "durationSeconds": 56.75, "channel": "16"},
        ]
        with patch.object(trial, "get_json", side_effect=AssertionError("unexpected API call")):
            chosen = trial.select_records([829, 819], records)
        self.assertEqual([record["id"] for record in chosen], [829, 819])

    def test_missing_explicit_id_errors_instead_of_silent_fallback(self):
        records = [{"id": 829, "durationSeconds": 21.38, "channel": "80A"}]
        with self.assertRaisesRegex(RuntimeError, "not present"):
            trial.select_records([999], records)

    def test_default_missing_ids_use_bounded_metadata_fallback(self):
        records = [
            {"id": 829, "durationSeconds": 41.38, "channel": "80A"},
            {"id": 818, "durationSeconds": 10.21, "channel": "14"},
        ]
        chosen = trial.select_records(trial.TARGET_IDS, records)
        self.assertEqual([record["id"] for record in chosen], [829, 818])

    def test_transcript_normalization_and_comparison_do_not_expose_text(self):
        raw = "\x1b[32m[00:00:01.000 --> 00:00:02.000] MAYDAY vessel\x1b[0m [BLANK_AUDIO]"
        words = trial.normalize_words(raw)
        comparison = trial.compare_words(words, trial.normalize_words("Mayday vessel").copy())
        self.assertEqual(words, ["mayday", "vessel"])
        self.assertEqual(comparison["word_edit_distance_from_fresh_raw_run"], 0)
        self.assertEqual(comparison["raw_reference_word_count"], 2)

    def test_waveform_fit_recovers_fixed_gain_and_offset(self):
        reference = [((index * 37) % 2000) - 1000 for index in range(1000)]
        estimate = [round(value * 0.25 + 17) for value in reference]
        result = waveform_analysis.fit_activity(reference, estimate, 0, len(reference), 0)
        self.assertAlmostEqual(result["fitted_gain_db"], -12.0412, places=2)
        self.assertGreater(result["pearson_full_activity"], 0.99999)
        self.assertEqual(result["common_activity_samples"], len(reference))

    def test_waveform_alignment_finds_known_sample_shift(self):
        reference = [((index * 53 + index * index * 3) % 5000) - 2500 for index in range(2000)]
        shift = 40
        estimate = [0] * shift + reference[:-shift]
        lag, correlation = waveform_analysis.find_alignment_lag(reference, estimate, 500, 500, max_lag=100)
        self.assertEqual(lag, shift)
        self.assertGreater(correlation, 0.99999)


if __name__ == "__main__":
    unittest.main()
