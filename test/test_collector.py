"""End-to-end CPU JIT collection, real cache boundaries, and script lifecycle."""

from __future__ import annotations

import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import subprocess
import sys
import time

import pytest

EXTENSION = Path(__file__).resolve().parents[1]
RUNNER = EXTENSION / "python" / "runner.py"
EXAMPLE = EXTENSION / "examples" / "cpu_vecadd.py"


def make_request(tmp_path, entry=EXAMPLE, args=None, disabled=False):
    request = tmp_path / "request.json"
    events = tmp_path / "events.jsonl"
    request.write_text(json.dumps({
        "id": "collector-test", "entryPath": str(entry), "scriptArgs": args or [],
        "workingDirectory": str(tmp_path), "disableCache": disabled,
        "target": {"kind": "c"}, "executionBackend": "cython",
    }), encoding="utf-8")
    return request, events


def environment(tmp_path, cache=None):
    temporary = tmp_path / "tmp"
    temporary.mkdir(exist_ok=True)
    result = dict(os.environ, TMPDIR=str(temporary), TILELANG_CACHE_DIR=str(cache or tmp_path / "cache"))
    result.pop("TILELANG_DISABLE_CACHE", None)
    return result


def read_events(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def collect(tmp_path, entry=EXAMPLE, args=None, disabled=False, cache=None):
    request, events = make_request(tmp_path, entry, args, disabled)
    result = subprocess.run(
        [sys.executable, str(RUNNER), "--request", str(request), "--events", str(events)],
        cwd=EXTENSION, env=environment(tmp_path, cache), capture_output=True, text=True, timeout=90,
    )
    return result, read_events(events)


def kernels_from(events):
    kernels = {}
    for event in events:
        if event["type"] == "kernel":
            kernels[event["kernel"]["id"]] = event["kernel"]
        elif event["type"] == "kernel-update":
            kernels[event["kernelId"]].update(event["patch"])
        elif event["type"] == "stage":
            stages = kernels[event["kernelId"]]["stages"]
            previous = next((i for i, s in enumerate(stages) if s["id"] == event["stage"]["id"]), None)
            if previous is None:
                stages.append(event["stage"])
            else:
                stages[previous] = event["stage"]
    for kernel in kernels.values():
        kernel["stages"].sort(key=lambda s: s["sequence"])
    return list(kernels.values())


def helper_import():
    return f"import sys\nsys.path.insert(0, {str(EXAMPLE.parent)!r})\nfrom cpu_vecadd import vector_add\nimport tilelang\n"


def test_git_revision_belongs_to_tilelang_checkout(tmp_path):
    if shutil.which("git") is None:
        pytest.skip("Git is optional environment metadata")
    revision_for = runpy.run_path(str(RUNNER))["tilelang_git_revision"]
    repo = tmp_path / "source-checkout"
    repo.mkdir()
    source = repo / "tilelang" / "__init__.py"
    source.parent.mkdir()
    source.write_text("# tracked compiler source\n")

    def git(*args):
        return subprocess.run(
            ["git", "-c", "user.name=Collector Test", "-c", "user.email=test@example.invalid",
             "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

    git("init", "-q")
    git("add", "tilelang/__init__.py")
    git("commit", "-qm", "Compiler fixture")
    assert revision_for(str(source)) == git("rev-parse", "HEAD")

    installed = repo / ".venv" / "lib" / "python3.12" / "site-packages" / "tilelang" / "__init__.py"
    installed.parent.mkdir(parents=True)
    installed.write_text("# installed wheel inside another Git checkout\n")
    assert revision_for(str(installed)) is None
    # Even an installation directly at a repository root must be tracked there.
    git("rm", "--cached", "tilelang/__init__.py")
    assert revision_for(str(source)) is None


def test_script_main_argv_cwd_native_sources_and_memory_hit(tmp_path):
    entry = tmp_path / "entry with spaces.py"
    entry.write_text(helper_import() +
        "from pathlib import Path\nimport torch\n"
        "assert __name__ == '__main__'\n"
        "assert sys.argv[1:] == ['--name', '中文 argument']\n"
        "assert Path.cwd() == Path(__file__).parent\n"
        "program = vector_add(129)\n"
        "kernel = tilelang.compile(program, out_idx=2)\n"
        "Path('device.cpp').write_text(kernel.get_kernel_source(kernel_only=True))\n"
        "Path('wrapper.cpp').write_text(kernel.get_kernel_source(kernel_only=False))\n"
        "a, b = torch.ones(129), torch.ones(129)\n"
        "torch.testing.assert_close(kernel(a, b), a + b)\n"
        "tilelang.compile(program, out_idx=2)\n"
        "tilelang.compile(vector_add(130), out_idx=2)\n"
        "print('MAIN ARGV CWD AND CPU OUTPUT OK')\n", encoding="utf-8")
    result, events = collect(tmp_path, entry, ['--name', '中文 argument'])
    assert result.returncode == 0, result.stderr
    assert "MAIN ARGV CWD AND CPU OUTPUT OK" in result.stdout
    initial = events[0]["record"]
    assert initial["entry"]["source"] == entry.read_text()
    assert initial["entry"]["mode"] == "script" and initial["entry"]["function"] == "__main__"
    assert initial["entry"]["args"] == ['--name', '中文 argument']
    assert events[-1]["status"] == "succeeded"
    kernels = kernels_from(events)
    assert [k["cache"] for k in kernels] == ["miss", "hit", "miss"]
    assert kernels[1]["cacheSource"] == "memory"
    assert not any(s["kind"] in ("pass", "codegen", "jit") for s in kernels[1]["stages"])
    stages = kernels[0]["stages"]
    codegen = next(s for s in stages if s["kind"] == "codegen")
    assert codegen["afterText"] == (tmp_path / "device.cpp").read_text()
    native = [s for s in stages if s["kind"] == "jit"]
    assert [s["name"] for s in native] == ["native_compile", "module_load"]
    assert all(s["afterText"] == (tmp_path / "wrapper.cpp").read_text() for s in native)
    assert all(s["durationMs"] >= 0 and s["status"] == "succeeded" for s in native)
    passes = [s for s in stages if s["kind"] == "pass"]
    assert len(passes) > len({s["name"] for s in passes})
    assert any(s["changed"] is False for s in passes)
    assert any(s["parentId"] is not None for s in passes)
    ids = [s["id"] for k in kernels for s in k["stages"]]
    sequences = [s["sequence"] for k in kernels for s in k["stages"]]
    assert len(ids) == len(set(ids)) and len(sequences) == len(set(sequences))


def test_disk_hit_loads_actual_native_library_without_recompilation(tmp_path):
    first, _ = collect(tmp_path, args=['--size', '135', '--repeat', '1', '--verify'])
    assert first.returncode == 0, first.stderr
    second, events = collect(tmp_path, args=['--size', '135', '--repeat', '1', '--verify'])
    assert second.returncode == 0, second.stderr
    kernel, = kernels_from(events)
    assert kernel["cache"] == "hit" and kernel["cacheSource"] == "disk"
    assert [s["name"] for s in kernel["stages"] if s["kind"] == "jit"] == ["module_load"]
    assert not any(s["kind"] in ("pass", "codegen") for s in kernel["stages"])
    assert "CPU output verified" in second.stdout


@pytest.mark.parametrize("disabled", [False, True])
def test_lazy_and_eager_decorator_hits_are_observed_at_actual_lookup(tmp_path, disabled):
    entry = tmp_path / "decorators.py"
    entry.write_text(helper_import() +
        "import tilelang.cpu.language as T\nimport torch\n"
        "@tilelang.jit(out_idx=2)\n"
        "def lazy(size: int):\n"
        "    return vector_add(size)\n"
        "lazy(19)\nlazy(19)\n"
        "@tilelang.jit\n"
        "def eager(A: T.Tensor((8,), 'float32'), B: T.Tensor((8,), 'float32')):\n"
        "    with T.Kernel(1):\n"
        "        for i in T.serial(8):\n"
        "            B[i] = A[i] + 1.0\n"
        "a, b = torch.ones(8), torch.zeros(8)\n"
        "eager(a, b)\neager(a, b)\n"
        "torch.testing.assert_close(b, a + 1)\n", encoding="utf-8")
    result, events = collect(tmp_path, entry, disabled=disabled)
    assert result.returncode == 0, result.stderr
    kernels = kernels_from(events)
    assert len(kernels) == 4
    expected = "disabled" if disabled else "miss"
    assert [k["cache"] for k in kernels] == [expected, "hit", expected, "hit"]
    assert [kernels[i]["cacheSource"] for i in (1, 3)] == ["decorator", "decorator"]
    assert all(not any(s["kind"] == "pass" for s in kernels[i]["stages"]) for i in (1, 3))


def test_disabled_official_kernel_cache_recompiles_without_deleting_entries(tmp_path):
    result, _ = collect(tmp_path, args=['--repeat', '1'])
    assert result.returncode == 0, result.stderr
    manifest_paths = list((tmp_path / "cache").rglob("manifest.json"))
    assert manifest_paths
    before = {p: p.read_bytes() for p in manifest_paths}
    result, events = collect(tmp_path, args=['--repeat', '2'], disabled=True)
    assert result.returncode == 0, result.stderr
    assert [k["cache"] for k in kernels_from(events)] == ["disabled", "disabled"]
    assert all(p.read_bytes() == content for p, content in before.items())


def test_native_compiler_failure_preserves_real_wrapper_and_earlier_kernel(tmp_path):
    entry = tmp_path / "compile_fail.py"
    entry.write_text(helper_import() +
        "tilelang.compile(vector_add(11), out_idx=2)\n"
        "tilelang.compile(vector_add(12), out_idx=2, compile_flags=['-fnot-a-real-compiler-flag'])\n")
    result, events = collect(tmp_path, entry)
    assert result.returncode == 1
    assert events[-1]["status"] == "failed"
    kernels = kernels_from(events)
    assert [k["status"] for k in kernels] == ["succeeded", "failed"]
    failed = next(s for s in kernels[1]["stages"] if s["id"] == events[-1]["error"]["stageId"])
    assert failed["name"] == "native_compile" and failed["beforeText"]
    assert failed["afterText"] is None
    assert any(s["kind"] == "codegen" and s["status"] == "succeeded" for s in kernels[1]["stages"])
    assert "-fnot-a-real-compiler-flag" in events[-1]["error"]["traceback"]


def test_script_failure_after_jit_keeps_completed_kernel(tmp_path):
    entry = tmp_path / "script_fail.py"
    entry.write_text(helper_import() +
        "tilelang.compile(vector_add(), out_idx=2)\n"
        "raise RuntimeError('Script failure after successful CPU JIT')\n", encoding="utf-8")
    result, events = collect(tmp_path, entry)
    assert result.returncode == 1
    assert events[-1]["error"]["phase"] == "script"
    kernel, = kernels_from(events)
    assert kernel["status"] == "succeeded"
    assert any(s["name"] == "module_load" and s["status"] == "succeeded" for s in kernel["stages"])


@pytest.mark.parametrize("settings", ["target='cuda'", "target='c', execution_backend='tvm_ffi'"])
def test_explicit_other_backend_is_rejected_without_substituting_cpu(tmp_path, settings):
    entry = tmp_path / "unsupported.py"
    entry.write_text(helper_import() + f"tilelang.compile(vector_add(), {settings})\n")
    result, events = collect(tmp_path, entry)
    assert result.returncode == 1
    assert "supports CPU target='c', execution_backend='cython'" in events[-1]["error"]["message"]
    assert not kernels_from(events)


def test_script_without_jit_is_explicit(tmp_path):
    entry = tmp_path / "plain.py"
    entry.write_text("print('plain script')\n")
    result, events = collect(tmp_path, entry)
    assert result.returncode == 0
    assert not kernels_from(events)
    assert any("没有观察到" in e["log"]["text"] for e in events if e["type"] == "log")


@pytest.mark.parametrize("threaded", [False, True])
def test_caught_or_threaded_rejection_cannot_be_reported_as_success(tmp_path, threaded):
    entry = tmp_path / "caught_rejection.py"
    if threaded:
        rejected = (
            "from threading import Thread\n"
            "thread = Thread(target=lambda: tilelang.compile(vector_add(31)))\n"
            "thread.start()\nthread.join()\n"
        )
    else:
        rejected = (
            "try:\n"
            "    tilelang.compile(vector_add(31), target='cuda')\n"
            "except ValueError:\n"
            "    pass\n"
        )
    entry.write_text(helper_import() + rejected + "tilelang.compile(vector_add(32), out_idx=2)\n")
    result, events = collect(tmp_path, entry)
    assert result.returncode == 1
    assert events[-1]["status"] == "failed" and events[-1]["error"]["phase"] == "unsupported"
    assert events[-1]["error"]["traceback"]
    assert "main thread" in events[-1]["error"]["message"] if threaded else "supports CPU" in events[-1]["error"]["message"]
    kernels = kernels_from(events)
    assert len(kernels) == 1 and kernels[0]["status"] == "succeeded"
    assert not any("没有观察到" in e["log"]["text"] for e in events if e["type"] == "log")


@pytest.mark.skipif(os.name == "nt", reason="POSIX subprocess SIGINT delivery")
def test_live_jsonl_sigint_preserves_completed_jit(tmp_path):
    entry = tmp_path / "wait.py"
    entry.write_text(helper_import() +
        "import time\nfrom pathlib import Path\n"
        "tilelang.compile(vector_add(21), out_idx=2)\n"
        "Path('ready').write_text('ready')\ntime.sleep(40)\n")
    request, events_path = make_request(tmp_path, entry)
    process = subprocess.Popen(
        [sys.executable, str(RUNNER), "--request", str(request), "--events", str(events_path)],
        cwd=EXTENSION, env=environment(tmp_path), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 30
        while not (tmp_path / "ready").exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert (tmp_path / "ready").exists(), "Worker did not finish its first JIT"
        assert any(e["type"] == "kernel-update" and e["patch"].get("status") == "succeeded" for e in read_events(events_path))
        process.send_signal(signal.SIGINT)
        _, stderr = process.communicate(timeout=10)
        assert process.returncode == 130, stderr
        events = read_events(events_path)
        assert events[-1]["status"] == "cancelled"
        assert all(k["status"] == "succeeded" for k in kernels_from(events))
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


@pytest.mark.parametrize("contents", ["{broken", "[]", '{"scriptArgs":[NaN]}', None])
def test_bad_request_has_portable_failure_record(tmp_path, contents):
    request, events_path = make_request(tmp_path)
    if contents is None:
        data = json.loads(request.read_text())
        data["scriptArgs"] = [1]
        contents = json.dumps(data)
    request.write_text(contents)
    result = subprocess.run(
        [sys.executable, str(RUNNER), "--request", str(request), "--events", str(events_path)],
        env=environment(tmp_path), capture_output=True, text=True, timeout=10,
    )
    events = read_events(events_path)
    assert result.returncode == 1
    assert events[0]["type"] == "record" and events[-1]["error"]["phase"] == "request"
    assert events[0]["record"]["entry"]["args"] == []
