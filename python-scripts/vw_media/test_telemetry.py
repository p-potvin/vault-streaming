"""Tests for ASR run telemetry.

Uses a stub engine via asr.transcribe(model=...) so nothing here imports torch
or NeMo — which is the same reason asr.py defers those imports in the first
place.
"""

import os
import tempfile
import unittest
import wave

from vw_media import asr, telemetry


def _wav(seconds: float = 2.5, rate: int = 16000) -> str:
    path = os.path.join(tempfile.mkdtemp(), "clip.wav")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * int(rate * seconds))
    return path


class _Segment:
    def __init__(self, start, end, text):
        self.start, self.end, self.text = start, end, text


class _Engine:
    model_name = "nvidia/parakeet-tdt-0.6b-v3"

    def transcribe_file(self, path, language="en"):
        return [_Segment(0.0, 1.2, "hello there"), _Segment(1.2, 2.4, "again")]


class _Silent(_Engine):
    def transcribe_file(self, path, language="en"):
        return []


class _Broken(_Engine):
    def transcribe_file(self, path, language="en"):
        raise RuntimeError("cuda oom")


def _isolate():
    if not telemetry.available():
        return None
    from vaultwares_adk.telemetry import configure

    return configure(
        spool_dir=tempfile.mkdtemp(prefix="ve-asr-test"),
        api_url="http://127.0.0.1:9",
        post_timeout_s=0.15,
        enabled=True,
    )


class TestAudioDuration(unittest.TestCase):
    def test_reads_wav_length(self):
        # The real-time factor is the ASR metric that matters, and it is
        # meaningless without the clip length.
        self.assertAlmostEqual(telemetry.audio_duration_seconds(_wav(2.5)), 2.5, places=2)

    def test_non_wav_returns_none_rather_than_guessing(self):
        self.assertIsNone(telemetry.audio_duration_seconds("does-not-exist.mp3"))

    def test_missing_file_does_not_raise(self):
        self.assertIsNone(telemetry.audio_duration_seconds("/nope/missing.wav"))


class TestTranscribeIsUnchanged(unittest.TestCase):
    """Instrumentation must not alter what callers receive."""

    def setUp(self):
        _isolate()

    def test_segments_are_returned_verbatim(self):
        result = asr.transcribe(_wav(), model=_Engine())
        self.assertEqual(result, [
            {"start": 0.0, "end": 1.2, "text": "hello there"},
            {"start": 1.2, "end": 2.4, "text": "again"},
        ])

    def test_silence_is_an_empty_result_not_an_error(self):
        # asr.transcribe's contract: an empty list means the model ran and found
        # no speech. Recording that as a failure would make the reliability
        # widgets blame the model for a quiet clip.
        self.assertEqual(asr.transcribe(_wav(), model=_Silent()), [])

    def test_engine_failure_still_propagates(self):
        with self.assertRaises(RuntimeError):
            asr.transcribe(_wav(), model=_Broken())


@unittest.skipUnless(telemetry.available(), "vaultwares-adk submodule not initialised")
class TestRecordedFields(unittest.TestCase):
    def setUp(self):
        _isolate()

    def _record(self, engine, seconds=2.5):
        from vaultwares_adk.telemetry.worker import get_worker

        worker = get_worker()
        before = worker.stats()["queued"]
        try:
            asr.transcribe(_wav(seconds), model=engine)
        except RuntimeError:
            pass
        self.assertGreater(worker.stats()["queued"], before)

    def test_a_successful_run_is_recorded(self):
        self._record(_Engine())

    def test_a_failed_run_is_recorded_too(self):
        # A telemetry layer that only captures successes makes every
        # reliability number a lie.
        self._record(_Broken())

    def test_run_carries_asr_shape(self):
        with telemetry.run(model="m", audio_seconds=12.0) as run:
            run.set(segment_count=4, completion_chars=88)
        record = run.record
        self.assertEqual(record.provider, "nvidia-nemo")
        self.assertEqual(record.runtime, "nemo")
        self.assertEqual(record.task, "audio-asr")
        self.assertEqual(record.audio_seconds, 12.0)
        self.assertEqual(record.extra["segment_count"], 4)

    def test_local_work_is_free_with_an_exact_zero(self):
        # Distinguishes "cost nothing" from "cost unknown"; the free-vs-paid
        # split depends on it.
        with telemetry.run(model="m") as run:
            pass
        self.assertEqual(run.record.cost_usd, 0.0)
        self.assertTrue(run.record.is_free)
        self.assertTrue(run.record.priced_exactly)


class TestDegradesWithoutAdk(unittest.TestCase):
    def test_null_run_accepts_any_call(self):
        # When the submodule is missing, call sites must still read the same.
        null = telemetry._NullRun()
        with null as run:
            run.set(anything=1).tag("x").first_token().usage(prompt=1)
        self.assertIsNone(null.record)


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(telemetry.available(), "vaultwares-adk submodule not initialised")
class TestStreamingSession(unittest.TestCase):
    """live_subtitles records one run per session, not per chunk.

    Chunks are ~1.1 s, so a two-hour stream would otherwise write some 7,000
    rows describing one piece of work -- and the real-time factor, the number
    that matters for streaming ASR, only exists at session grain.
    """

    def setUp(self):
        _isolate()

    def _session(self, stopped=False, audio_seconds=3600.0, segments=412):
        run = telemetry.run(
            model="nvidia/nemotron-3.5-asr-streaming-0.6b",
            task="audio-asr",
            runtime="nemo-streaming",
            service="live-subtitles",
            stream=True,
            chunk_seconds=1.12,
        )
        run.start()
        run.set(audio_seconds=audio_seconds, segment_count=segments, output_bytes=1024)
        if stopped:
            run.set(status="cancelled")
        run.close()
        return run.record

    def test_session_carries_streaming_shape(self):
        record = self._session()
        self.assertEqual(record.runtime, "nemo-streaming")
        self.assertTrue(record.stream)
        self.assertEqual(record.audio_seconds, 3600.0)
        self.assertEqual(record.extra["segment_count"], 412)

    def test_a_stopped_session_is_cancelled_not_failed(self):
        # Stopping live subtitles is a decision, not a fault; recording it as an
        # error would make every manual stop look like a model failure.
        self.assertEqual(self._session(stopped=True).status, "cancelled")

    def test_a_completed_session_is_ok(self):
        self.assertEqual(self._session().status, "ok")

    def test_module_import_does_not_pull_in_torch(self):
        # load_model() defers torch/NeMo on purpose; the telemetry import must
        # not undo that.
        import sys

        import live_subtitles  # noqa: F401

        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("nemo", sys.modules)

