import io
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name('transcription_worker.py')
spec = importlib.util.spec_from_file_location('transcription_worker', MODULE_PATH)
worker = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)

class WorkerAdapterTest(unittest.TestCase):
    def test_fake_adapter_does_not_load_whisper(self):
        with tempfile.TemporaryDirectory() as folder:
            media = Path(folder) / 'audio.ogg'; media.write_bytes(b'fake-audio')
            text, language, enrichment = worker.FakeAdapter().transcribe(media)
            self.assertIn('10 bytes', text); self.assertEqual(language, 'pt'); self.assertTrue(enrichment['fake'])
    def test_sanitizes_service_key(self):
        import os
        os.environ['SUPABASE_SERVICE_ROLE_KEY'] = 'top-secret-key'
        self.assertNotIn('top-secret-key', worker.sanitize(RuntimeError('bad top-secret-key')))

    def test_bounded_reader_rejects_oversized_media(self):
        with self.assertRaisesRegex(ValueError, 'media_too_large'):
            worker.read_bounded(io.BytesIO(b'x' * 11), max_bytes=10)
        self.assertEqual(worker.read_bounded(io.BytesIO(b'123'), max_bytes=10), b'123')

    def test_finalize_must_confirm_current_lease(self):
        original = worker._request
        try:
            worker._request = lambda *args, **kwargs: False
            with self.assertRaisesRegex(RuntimeError, 'stale_transcription_lease'):
                worker.finalize_job(worker.Settings('https://db.test', 'key'), {
                    'id': 'job-1', 'lease_token': 'lease-1'
                }, 'texto', 'pt', 'fake', 10, {})
        finally:
            worker._request = original

if __name__ == '__main__': unittest.main()
