"""Enhancement state lives in the video's v2 sidecar, next to what other tools keep there (Fri 06 Nov 2026)."""

import json
import os
import tempfile
import unittest

from vw_media import state


class EnhancementState(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def touch(self, name, data=b"x"):
        p = os.path.join(self.d, name)
        with open(p, "wb") as fh:
            fh.write(data)
        return p

    def read(self, p):
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)

    def test_a_new_sidecar_is_the_canonical_v2_record(self):
        video = self.touch("clip.mp4")
        state.mark(video, "subtitles", languages=["en"], outputs=["clip.en.srt"])
        self.assertEqual(os.listdir(self.d), ["clip.mp4", "clip.mp4.json"])
        rec = self.read(video + ".json")
        self.assertEqual(rec["schema"], 2)
        self.assertEqual(rec["vw"]["kind"], "video")
        self.assertEqual(rec["master"]["basename"], "clip.mp4")
        self.assertEqual(rec["enhancements"]["subtitles"], ["en"])
        self.assertTrue(state.is_applied(video, "subtitles", "en"))

    def test_other_tools_keys_survive_and_a_revert_reaches_the_file(self):
        video = self.touch("clip.mkv")
        enhanced = self.touch("clip_enhanced.mkv")
        with open(video + ".json", "w", encoding="utf-8") as fh:
            json.dump({"schema": 2, "vw": {"id": "01ARZ3NDEKTSV4RRFFQ69G5FAV"}, "tags": {"tracks": {}},
                       "duration": 12.5, "path": "D:\old\clip.mkv"}, fh)
        state.mark(video, "audio", enhanced_path=enhanced)
        rec = self.read(video + ".json")
        self.assertEqual(rec["vw"]["id"], "01ARZ3NDEKTSV4RRFFQ69G5FAV")
        self.assertEqual(rec["tags"], {"tracks": {}})
        self.assertEqual(rec["duration"], 12.5)
        self.assertNotIn("path", rec)                              # an absolute path is wrong after any move
        self.assertEqual(rec["enhancedPath"], enhanced)
        state.clear(video, "audio")
        rec = self.read(video + ".json")
        self.assertNotIn("enhancedPath", rec)
        self.assertFalse(rec["enhancements"]["audio"])
        self.assertEqual(rec["vw"]["id"], "01ARZ3NDEKTSV4RRFFQ69G5FAV")

    def test_an_existing_name_is_kept_and_a_shared_stem_is_not_claimed(self):
        old = self.touch("old.mp4")
        self.touch("old.mp4.meta.json", b'{"enhancements": {"video": true}}')
        self.assertTrue(state.is_applied(old, "video"))
        state.mark(old, "audio")
        self.assertFalse(os.path.exists(old + ".json"))
        self.assertTrue(self.read(old + ".meta.json")["enhancements"]["video"])
        movie = self.touch("movie.mp4")
        self.touch("movie.jpg")
        self.touch("movie.json", b'{"enhancements": {"video": true}}')   # the poster's, not the video's
        self.assertFalse(state.is_applied(movie, "video"))
        self.assertEqual(state.sidecar_path(movie), movie + ".json")


if __name__ == "__main__":
    unittest.main()
