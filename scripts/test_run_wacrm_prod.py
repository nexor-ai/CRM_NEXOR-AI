import importlib.util
from pathlib import Path


def load_runner():
    path = Path(__file__).with_name('run-wacrm-prod.py')
    spec = importlib.util.spec_from_file_location('run_wacrm_prod', path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_production_runner_uses_isolated_build(monkeypatch, tmp_path):
    runner = load_runner()
    env_file = tmp_path / '.env'
    env_file.write_text('NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\n')
    build_dir = tmp_path / '.next-production'
    build_dir.mkdir()
    (build_dir / 'BUILD_ID').write_text('build-1')

    monkeypatch.setattr(runner, 'PROJECT_DIR', tmp_path)
    monkeypatch.setattr(runner, 'ENV_PATH', env_file)
    monkeypatch.setattr(runner.subprocess, 'call', lambda cmd, cwd: 0)
    monkeypatch.delenv('NEXT_DIST_DIR', raising=False)

    assert runner.main() == 0
    assert runner.os.environ['NEXT_DIST_DIR'] == '.next-production'


def test_production_runner_refuses_missing_promoted_build(monkeypatch, tmp_path):
    runner = load_runner()
    env_file = tmp_path / '.env'
    env_file.write_text('A=B\n')

    monkeypatch.setattr(runner, 'PROJECT_DIR', tmp_path)
    monkeypatch.setattr(runner, 'ENV_PATH', env_file)
    monkeypatch.delenv('NEXT_DIST_DIR', raising=False)

    try:
        runner.main()
    except SystemExit as exc:
        assert 'Production build not found' in str(exc)
    else:
        raise AssertionError('runner must fail closed without promoted build')
