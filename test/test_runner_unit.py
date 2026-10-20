"""Collector helpers that run without installing TileLang."""
import runpy
from pathlib import Path
import unittest

changes = runpy.run_path(str(Path(__file__).resolve().parents[1] / "python" / "runner.py"))["changes"]


class ChangesTests(unittest.TestCase):
    def test_small_exact_statistics(self):
        self.assertEqual(changes("a\nb\n", "a\nc\nd\n"), (True, 2, 1))
        self.assertEqual(changes("", "a\n"), (True, 1, 0))
        self.assertEqual(changes("a\n", ""), (True, 0, 1))

    def test_large_identical_text_stays_exact(self):
        text = "repeat\n" * 100_000
        self.assertEqual(changes(text, text), (False, 0, 0))

    def test_repetitive_lines_skip_expensive_matching(self):
        text = "repeat\n" * 10_000
        self.assertEqual(changes(text, text + "changed\n"), (True, None, None))

    def test_large_single_line_skips_statistics(self):
        self.assertEqual(changes("x" * 600_000, "y"), (True, None, None))
