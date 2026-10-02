import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from run import RATE, align


def reference_signal() -> list[float]:
    return [
        (0.5 + 0.35 * math.sin(2 * math.pi * 2.1 * index / RATE))
        * (
            0.50 * math.sin(2 * math.pi * 431 * index / RATE)
            + 0.31 * math.sin(2 * math.pi * 883 * index / RATE)
            + 0.19 * math.sin(2 * math.pi * 1477 * index / RATE)
            + 0.11 * math.sin(2 * math.pi * 2653 * index / RATE)
        )
        for index in range(round(0.4 * RATE))
    ]


class AlignmentTests(unittest.TestCase):
    def test_finds_full_rate_positive_delay_of_400_samples(self) -> None:
        reference = reference_signal()
        estimate = [0.0] * 400 + reference[:-400]

        aligned_reference, aligned_estimate, delay = align(reference, estimate)

        self.assertEqual(delay, 400)
        self.assertEqual(len(aligned_reference), len(reference) - 400)
        self.assertEqual(aligned_reference, aligned_estimate)

    def test_finds_negative_delay_and_respects_common_length(self) -> None:
        reference = reference_signal()
        estimate = reference[400:] + [0.0] * 400

        aligned_reference, aligned_estimate, delay = align(reference, estimate)

        self.assertEqual(delay, -400)
        self.assertEqual(len(aligned_reference), len(reference) - 400)
        self.assertEqual(aligned_reference, aligned_estimate)

    def test_zero_delay_and_shorter_estimate(self) -> None:
        reference = reference_signal()

        aligned_reference, aligned_estimate, delay = align(reference, reference[:5_000])

        self.assertEqual(delay, 0)
        self.assertEqual(len(aligned_reference), 5_000)
        self.assertEqual(aligned_reference, aligned_estimate)


if __name__ == "__main__":
    unittest.main()
