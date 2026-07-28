import importlib.util
from pathlib import Path


def load_rollback():
    path = Path(__file__).with_name('rollback-wacrm-production.py')
    spec = importlib.util.spec_from_file_location('rollback_wacrm_production', path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(path: Path, build_id: str) -> None:
    path.mkdir()
    (path / 'BUILD_ID').write_text(build_id)


def test_rollback_atomically_swaps_current_and_previous(monkeypatch, tmp_path):
    rollback = load_rollback()
    current = tmp_path / '.next-production'
    previous = tmp_path / '.next-production.previous'
    build(current, 'current-build')
    build(previous, 'previous-build')

    monkeypatch.setattr(rollback, 'PROJECT_DIR', tmp_path)

    assert rollback.main() == 0
    assert (current / 'BUILD_ID').read_text() == 'previous-build'
    assert (previous / 'BUILD_ID').read_text() == 'current-build'
    assert not (tmp_path / '.next-production.rollback').exists()


def test_rollback_refuses_missing_previous_build(monkeypatch, tmp_path):
    rollback = load_rollback()
    build(tmp_path / '.next-production', 'current-build')
    monkeypatch.setattr(rollback, 'PROJECT_DIR', tmp_path)

    try:
        rollback.main()
    except SystemExit as exc:
        assert 'Previous production build not found' in str(exc)
    else:
        raise AssertionError('rollback must fail closed without a previous build')
