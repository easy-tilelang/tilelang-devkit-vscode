#!/usr/bin/env python3
"""Observe a Python script's complete CPU C/Cython JIT as JSONL events.

The worker intentionally imports only the standard library until the initial
record (including the user's source) is safely written. stdout and stderr are
ordinary logs; the event file is a separate, incrementally flushed channel.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager, ExitStack
from contextvars import ContextVar
from datetime import datetime, timezone
import difflib
import importlib
import inspect
import json
import os
from pathlib import Path
import signal
import runpy
import subprocess
import sys
import time
import threading
import tokenize
import traceback
from typing import Any
from uuid import uuid4


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def tilelang_git_revision(module_path: str) -> str | None:
    """Report a source checkout's revision, never an enclosing project's HEAD."""
    package = Path(module_path).resolve()
    root = package.parent.parent
    if package.parent.name != "tilelang":
        return None
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel", "HEAD"],
            capture_output=True, text=True, timeout=3, check=False,
        )
        lines = result.stdout.splitlines()
        if result.returncode != 0 or len(lines) != 2 or Path(lines[0]).resolve() != root:
            return None
        tracked = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--error-unmatch", "--", str(package.relative_to(root))],
            capture_output=True, text=True, timeout=3, check=False,
        )
        return lines[1] if tracked.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def error_info(error: BaseException, phase: str, stage_id: str | None = None) -> dict:
    result = {"phase": phase, "message": str(error) or type(error).__name__}
    if stage_id is not None:
        result["stageId"] = stage_id
    return result


def changes(before: str, after: str) -> tuple[bool, int | None, int | None]:
    if before == after:
        return False, 0, 0
    # Statistics are optional: never let quadratic matching dominate collection.
    # Bound both tokenization memory and the worst-case line-pair search space.
    if len(before) + len(after) > 512 * 1024:
        return True, None, None
    before_lines, after_lines = before.splitlines(), after.splitlines()
    if len(before_lines) * len(after_lines) > 250_000:
        return True, None, None
    added = deleted = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, before_lines, after_lines, autojunk=False).get_opcodes():
        if tag in ("insert", "replace"):
            added += j2 - j1
        if tag in ("delete", "replace"):
            deleted += i2 - i1
    return True, added, deleted


class EventWriter:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.file = path.open("w", encoding="utf-8")

    def emit(self, event: dict) -> None:
        self.file.write(json.dumps(event, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
        self.file.flush()

    def close(self) -> None:
        self.file.close()


class Run:
    def __init__(self, request: dict, writer: EventWriter):
        self.writer = writer
        self.request = request
        self.sequence = 0
        self.started = time.perf_counter_ns()
        self.last_error: dict | None = None
        self.rejection: dict | None = None
        self.record = {
            "schemaVersion": 1,
            "id": str(request.get("id") or uuid4()),
            "provenance": "real",
            "createdAt": now(),
            "status": "running",
            "durationMs": None,
            "entry": {
                "path": str(request.get("entryPath", "")),
                "function": "__main__",
                "kwargs": {},
                "source": "",
                "mode": "script",
                "args": request.get("scriptArgs", []) if isinstance(request.get("scriptArgs"), list)
                and all(isinstance(arg, str) for arg in request["scriptArgs"]) else [],
                "cwd": str(request.get("workingDirectory", "")),
            },
            "environment": {
                "python": sys.version.split()[0],
                "tilelangVersion": "unavailable",
                "tilelangPath": "",
                "target": {"kind": "c"},
                "executionBackend": "cython",
                "compilationMode": "jit",
            },
            "kernels": [],
            "logs": [],
        }

    def allocate(self) -> int:
        sequence = self.sequence
        self.sequence += 1
        return sequence

    def stage(self, kernel: dict, kind: str, name: str, before: str | None = None, after: str | None = None, **fields) -> dict:
        sequence = self.allocate()
        stage = {
            "id": f"stage-{sequence}",
            "sequence": sequence,
            "kind": kind,
            "name": name,
            "phase": None,
            "parentId": None,
            "depth": 0,
            "status": "running" if after is None else "succeeded",
            "beforeText": before,
            "afterText": after,
            "beforeLanguage": "python",
            "afterLanguage": "cpp" if kind in ("codegen", "jit", "cache") else "python",
            "durationMs": None,
            "changed": None,
            "added": None,
            "deleted": None,
            **fields,
        }
        kernel["stages"].append(stage)
        self.emit_stage(kernel, stage)
        return stage

    def emit_stage(self, kernel: dict, stage: dict) -> None:
        self.writer.emit({"type": "stage", "kernelId": kernel["id"], "stage": stage})

    def update_kernel(self, kernel: dict, **patch) -> None:
        kernel.update(patch)
        self.writer.emit({"type": "kernel-update", "kernelId": kernel["id"], "patch": patch})

    def log(self, text: str) -> None:
        log = {"timestamp": now(), "stream": "system", "text": text}
        self.record["logs"].append(log)
        self.writer.emit({"type": "log", "log": log})

    def finish(self, status: str, error: dict | None = None) -> None:
        self.record.update(status=status, endedAt=now(), durationMs=(time.perf_counter_ns() - self.started) / 1e6)
        event = {"type": "finish", "status": status, "durationMs": self.record["durationMs"]}
        if error is not None:
            self.record["error"] = error
            event["error"] = error
        self.writer.emit(event)


def collector_type():
    """Build the adapter only after TileLang's optional import has succeeded."""
    from tilelang.instrumentation import PassEventObserver, PassInstrumentationTool, StackedPassInstrument, pass_phase

    class Collector(PassInstrumentationTool, PassEventObserver):
        def __init__(self, run: Run, kernel: dict):
            self.run = run
            self.kernel = kernel
            self.instruments = []
            self.stages: dict[int, dict] = {}
            self.incomplete_ids: set[str] = set()
            self.finished = False

        def create_pass_instrument(self):
            instrument = StackedPassInstrument(self, sequence_allocator=self.run.allocate)
            self.instruments.append(instrument)
            return instrument

        def pass_started(self, mod, event):
            before = str(mod)
            stage = {
                "id": f"stage-{event.sequence}",
                "sequence": event.sequence,
                "kind": "pass",
                "name": event.name,
                "phase": event.phase or "unscoped",
                "parentId": f"stage-{event.parent_sequence}" if event.parent_sequence is not None else None,
                "depth": event.depth,
                "status": "running",
                "beforeText": before,
                "afterText": None,
                "beforeLanguage": "python",
                "afterLanguage": "python",
                "durationMs": None,
                "changed": None,
                "added": None,
                "deleted": None,
            }
            self.stages[event.sequence] = stage
            self.kernel["stages"].append(stage)
            self.run.emit_stage(self.kernel, stage)
            return time.perf_counter_ns()

        def pass_finished(self, mod, event, started):
            duration = (time.perf_counter_ns() - started) / 1e6
            stage = self.stages[event.sequence]
            after = str(mod)
            changed, added, deleted = changes(stage["beforeText"], after)
            stage.update(afterText=after, durationMs=duration, status="succeeded", changed=changed, added=added, deleted=deleted)
            self.run.emit_stage(self.kernel, stage)

        def passes_incomplete(self, passes, error):
            for item in passes:
                if item.event is None:
                    continue
                stage = self.stages[item.event.sequence]
                stage["status"] = "cancelled" if isinstance(error, KeyboardInterrupt) else "failed"
                if item.state is not None:
                    stage["durationMs"] = (time.perf_counter_ns() - item.state) / 1e6
                stage["error"] = error_info(error or RuntimeError("Pass did not complete"), stage["name"], stage["id"])
                self.incomplete_ids.add(stage["id"])
                self.run.emit_stage(self.kernel, stage)

        def callback_mismatch(self, actual, expected):
            raise RuntimeError(f"Pass callback mismatch: got {actual!r}, expected {expected!r}")

        @contextmanager
        def pipeline_scope(self, base_phase):
            try:
                yield
            except BaseException as error:
                for instrument in reversed(self.instruments):
                    instrument.abort(error)
                raise

        def run_codegen(self, event, next_call):
            stage = self.run.stage(
                self.kernel, "codegen", f"codegen_{event.role}", before=str(event.mod), phase="codegen"
            )
            started = time.perf_counter_ns()
            try:
                with pass_phase("codegen"):
                    result = next_call()
                duration = (time.perf_counter_ns() - started) / 1e6
                source_getter = getattr(result, "inspect_source", None) or getattr(result, "get_source", None)
                if source_getter is None:
                    raise RuntimeError("Codegen result provides no source inspection API")
                source = source_getter()
                if not isinstance(source, str) or not source.strip():
                    raise RuntimeError("Codegen produced empty source")
                changed, added, deleted = changes(stage["beforeText"], source)
                stage.update(afterText=source, durationMs=duration, status="succeeded", changed=changed, added=added, deleted=deleted)
            except BaseException as error:
                stage.update(
                    status="cancelled" if isinstance(error, KeyboardInterrupt) else "failed",
                    durationMs=(time.perf_counter_ns() - started) / 1e6,
                    error=error_info(error, stage["name"], stage["id"]),
                )
                raise
            finally:
                # Internal passes must precede the generated source in navigation.
                # Updating sequence does not change the stable stage identity.
                stage["sequence"] = self.run.allocate()
                self.run.emit_stage(self.kernel, stage)
            return result

        def finish(self, error):
            if self.finished:
                return
            self.finished = True
            for instrument in reversed(self.instruments):
                instrument.abort(error)
            if error is not None:
                # PassContext teardown can report an incomplete frame before the
                # owning compiler context supplies the actual exception.
                for stage in self.kernel["stages"]:
                    if stage["id"] in self.incomplete_ids:
                        stage["status"] = "cancelled" if isinstance(error, KeyboardInterrupt) else "failed"
                        stage["error"] = error_info(error, stage["name"], stage["id"])
                        self.run.emit_stage(self.kernel, stage)

    return Collector


class JITObservation:
    """Version-scoped observation of actual cache returns and native JIT calls.

    Passes/codegen use TileLang's public instrumentation. The small wrappers
    below observe Python boundaries that have no public cache/native events in
    TileLang 0.1.15. They delegate exactly once and never synthesize cache hits
    from an absence of pass callbacks.
    """

    def __init__(self, run: Run):
        self.run = run
        self.active = ContextVar("tilelang_workbench_jit", default=None)
        self.Collector = collector_type()

    def check_thread(self):
        if threading.current_thread() is not threading.main_thread():
            self.reject(RuntimeError("This collector supports synchronous JIT in the script's main thread; threaded JIT is unsupported"))

    def reject(self, error):
        # Rejections can occur before a kernel exists, including on a worker
        # thread whose exception threading.join() does not propagate. Latch the
        # observation so catching it cannot turn a rejected run into success.
        if self.run.rejection is None:
            failure = error_info(error, "unsupported")
            failure["traceback"] = "".join(traceback.format_stack()) + f"{type(error).__name__}: {error}\n"
            self.run.rejection = failure
        raise error

    def check_target(self, target=None, backend=None):
        kind = getattr(getattr(target, "kind", None), "name", None)
        if isinstance(target, dict):
            kind = target.get("kind")
        elif isinstance(target, str):
            kind = target.split()[0] if target.strip() else ""
        if kind not in (None, "auto", "c") or backend not in (None, "auto", "cython"):
            self.reject(ValueError(
                "This collector supports CPU target='c', execution_backend='cython'; "
                f"got target={target!s}, backend={backend!s}"
            ))

    def operation(self, func, invoke):
        from tilelang import env, tvm

        self.check_thread()
        if self.active.get() is not None:
            self.reject(RuntimeError("Nested independent JIT compilation is not supported by this collector"))
        symbol = str(func.attrs.get("global_symbol", "<unnamed>"))
        kernel = {
            "id": f"kernel-{len(self.run.record['kernels'])}", "name": symbol, "symbol": symbol,
            "status": "running", "cache": "disabled" if not env.is_cache_enabled() else "unknown",
            "cacheSource": "disabled" if not env.is_cache_enabled() else "unknown", "stages": [],
        }
        self.run.record["kernels"].append(kernel)
        self.run.writer.emit({"type": "kernel", "kernel": kernel})
        self.run.stage(kernel, "source", Path(self.run.record["entry"]["path"]).name,
                       after=self.run.record["entry"]["source"], phase="source")
        self.run.stage(kernel, "frontend", "Frontend IR", after=str(tvm.IRModule({symbol: func})), phase="frontend")
        operation = {"kernel": kernel, "collector": self.Collector(self.run, kernel), "hostSource": None, "compiled": False}
        token = self.active.set(operation)
        try:
            result = invoke()
            self.check_target(result.target, result.execution_backend)
            if getattr(getattr(result, "adapter", None), "lib", None) is None:
                raise RuntimeError("CPU Cython JIT returned without a loaded native library")
            source = result.get_kernel_source()
            codegen = [s for s in kernel["stages"] if s["kind"] == "codegen" and s["status"] == "succeeded"]
            if codegen and codegen[-1]["afterText"] != source:
                raise RuntimeError("Captured codegen source differs from the completed JIT kernel source")
            wrapped_source = result.get_kernel_source(kernel_only=False)
            native_stages = [s for s in kernel["stages"] if s["kind"] == "jit" and s["status"] == "succeeded"]
            for stage in native_stages:
                if stage["afterLanguage"] == "cpp" and stage["afterText"] != wrapped_source:
                    raise RuntimeError("Captured native compilation source differs from the completed JIT host wrapper source")
            if kernel["cache"] == "hit":
                self.run.stage(kernel, "cache", f"cache_{kernel['cacheSource']}", after=source,
                               phase="cache", status="succeeded")
                if source is None:
                    self.run.log("缓存已命中，但缓存条目未提供 kernel 源码。\n")
            elif not operation["compiled"]:
                # This is an unsupported path, not evidence of a cache hit.
                raise RuntimeError("JIT completed through an unrecognized cache/compile path; cache state cannot be determined")
            self.run.update_kernel(kernel, status="succeeded")
            return result
        except BaseException as error:
            operation["collector"].finish(error)
            status = "cancelled" if isinstance(error, KeyboardInterrupt) else "failed"
            self.run.update_kernel(kernel, status=status)
            failure = error_info(error, "jit")
            failure["traceback"] = "".join(traceback.format_exception(type(error), error, error.__traceback__))
            failed = [s for s in kernel["stages"] if s["status"] in ("failed", "cancelled")]
            if failed:
                nearest = max(failed, key=lambda s: (s["depth"], s["sequence"]))
                failure.update(stageId=nearest["id"], phase=nearest["name"])
            self.run.last_error = failure
            raise
        finally:
            self.active.reset(token)

    def hit(self, source):
        operation = self.active.get()
        if operation is not None:
            self.run.update_kernel(operation["kernel"], cache="hit", cacheSource=source)

    def decorator_hit(self, kernel):
        # The value was returned by a real decorator cache lookup, including
        # eager-mode calls whose public return value is a tensor rather than JITKernel.
        self.operation(kernel.prim_func, lambda: (self.hit("decorator"), kernel)[1])

    def native(self, name, generator, invoke):
        operation = self.active.get()
        if operation is None:
            return invoke()
        source = generator.lib_code or operation["hostSource"]
        if source is None:
            language = "text"
            self.run.log(f"{name}: 此缓存条目未提供 native wrapper 源码。\n")
        else:
            language = "cpp"
        stage = self.run.stage(operation["kernel"], "jit", name, before=source,
                               phase="jit", beforeLanguage=language, afterLanguage=language)
        started = time.perf_counter_ns()
        try:
            result = invoke()
            stage.update(status="succeeded", afterText=source)
            if source is not None:
                stage.update(changed=False, added=0, deleted=0)
            if generator.libpath:
                self.run.log(f"{name}: {generator.libpath}\n")
            return result
        except BaseException as error:
            stage.update(status="cancelled" if isinstance(error, KeyboardInterrupt) else "failed",
                         error=error_info(error, name, stage["id"]))
            raise
        finally:
            stage["durationMs"] = (time.perf_counter_ns() - started) / 1e6
            self.run.emit_stage(operation["kernel"], stage)

    @contextmanager
    def installed(self):
        from unittest.mock import patch
        import tilelang
        from tilelang import env
        from tilelang.cache.kernel_cache import KernelCache
        from tilelang.instrumentation import (
            PassInstrumentationTool, register_pass_instrumentation_tool, unregister_pass_instrumentation_tool,
        )
        from tilelang.jit.adapter.libgen import LibraryGenerator
        from tilelang.jit.kernel import JITKernel

        jit = importlib.import_module("tilelang.jit")
        cache_module = importlib.import_module("tilelang.cache")
        observation = self
        original_cached = KernelCache.cached
        original_disk = KernelCache._load_kernel_from_disk
        original_build = KernelCache._build_kernel
        original_compile = JITKernel._compile_and_create_adapter
        original_init = JITKernel.__init__
        original_post_init = jit.JITImpl.__post_init__
        original_lookup = jit._CallFormCache.lookup
        original_dispatch = cache_module._resolve_cache_dispatch
        original_native = LibraryGenerator.compile_lib
        original_load = LibraryGenerator.load_lib
        init_signature = inspect.signature(original_init)

        class ObservedCache(dict):
            def __init__(self, values, source):
                super().__init__(values)
                self.source = source

            def __getitem__(self, key):
                value = super().__getitem__(key)
                if self.source == "memory":
                    observation.hit("memory")
                return value

            def get(self, key, default=None):
                value = super().get(key, default)
                if self.source == "decorator" and isinstance(value, JITKernel):
                    observation.decorator_hit(value)
                return value

        def dispatch(target, target_host, execution_backend, verbose):
            self.check_thread()
            self.check_target(target, execution_backend)
            result = original_dispatch(target, target_host, execution_backend, verbose)
            self.check_target(result[1].target, result[1].execution_backend.name)
            return result

        def cached(cache, func=None, *args, **kwargs):
            context = kwargs.get("backend_context")
            self.check_target(context.target if context else kwargs.get("target"),
                              context.execution_backend.name if context else kwargs.get("execution_backend"))
            return self.operation(func, lambda: original_cached(cache, func, *args, **kwargs))

        def disk(cache, *args, **kwargs):
            result = original_disk(cache, *args, **kwargs)
            if result is not None:
                self.hit("disk")
            return result

        def build(cache, *args, **kwargs):
            operation = self.active.get()
            if operation is not None:
                bound = inspect.signature(original_build).bind(cache, *args, **kwargs)
                source = bound.arguments.get("host_kernel_source")
                if source is not None:
                    operation["hostSource"] = source.text
                    if source.text is None and source.path:
                        try:
                            operation["hostSource"] = Path(source.path).read_text(encoding="utf-8")
                        except OSError:
                            pass
            return original_build(cache, *args, **kwargs)

        def compile_adapter(kernel, *args, **kwargs):
            self.check_target(kernel.target, kernel.execution_backend)
            operation = self.active.get()
            if operation is not None:
                operation["compiled"] = True
                disabled = not env.is_cache_enabled()
                self.run.update_kernel(operation["kernel"], cache="disabled" if disabled else "miss",
                                       cacheSource="disabled" if disabled else "unknown")
            return original_compile(kernel, *args, **kwargs)

        def initialize(kernel, *args, **kwargs):
            bound = init_signature.bind(kernel, *args, **kwargs)
            context = bound.arguments.get("backend_context")
            self.check_target(context.target if context else bound.arguments.get("target"),
                              context.execution_backend.name if context else bound.arguments.get("execution_backend"))
            if self.active.get() is not None or bound.arguments.get("from_database"):
                return original_init(kernel, *args, **kwargs)

            def direct():
                original_init(kernel, *args, **kwargs)
                return kernel

            self.operation(bound.arguments.get("func"), direct)

        def decorator_init(instance):
            original_post_init(instance)
            instance._kernel_cache = ObservedCache(instance._kernel_cache, "decorator")

        def lookup(instance, *args, **kwargs):
            value, key = original_lookup(instance, *args, **kwargs)
            if value is not jit._CALL_FORM_CACHE_MISS:
                self.decorator_hit(value)
            return value, key

        def native_compile(generator, *args, **kwargs):
            return self.native("native_compile", generator, lambda: original_native(generator, *args, **kwargs))

        def native_load(generator, *args, **kwargs):
            return self.native("module_load", generator, lambda: original_load(generator, *args, **kwargs))

        def make_collector():
            operation = self.active.get()
            return operation["collector"] if operation is not None else PassInstrumentationTool()

        # Match the fixed TileLang API before running user code; unsupported
        # versions fail clearly instead of silently losing cache/JIT events.
        if str(tilelang.__version__).split("+", 1)[0] != "0.1.15":
            raise RuntimeError(f"CPU JIT collector supports TileLang 0.1.15; found {tilelang.__version__}")
        registration = f"vscode-trace-{self.run.record['id']}"
        with ExitStack() as stack:
            for obj, name, replacement in (
                (cache_module, "_resolve_cache_dispatch", dispatch),
                (KernelCache, "cached", cached), (KernelCache, "_load_kernel_from_disk", disk),
                (KernelCache, "_build_kernel", build), (JITKernel, "__init__", initialize),
                (JITKernel, "_compile_and_create_adapter", compile_adapter),
                (jit.JITImpl, "__post_init__", decorator_init), (jit._CallFormCache, "lookup", lookup),
                (LibraryGenerator, "compile_lib", native_compile), (LibraryGenerator, "load_lib", native_load),
            ):
                stack.enter_context(patch.object(obj, name, replacement))
            seen = set()
            for cache in cache_module._dispatch_map.values():
                if id(cache) not in seen:
                    seen.add(id(cache))
                    stack.enter_context(patch.object(cache, "_memory_cache", ObservedCache(cache._memory_cache, "memory")))
            register_pass_instrumentation_tool(registration, make_collector)
            stack.callback(unregister_pass_instrumentation_tool, registration)
            yield


def validate_request(request: Any) -> dict:
    if not isinstance(request, dict):
        raise ValueError("Request must be a JSON object")
    for key in ("id", "entryPath", "workingDirectory"):
        if not isinstance(request.get(key), str) or not request[key].strip():
            raise ValueError(f"{key} must be a non-empty string")
    if not isinstance(request.get("scriptArgs"), list) or any(not isinstance(arg, str) for arg in request["scriptArgs"]):
        raise ValueError("scriptArgs must be an array of strings")
    if not isinstance(request.get("disableCache"), bool):
        raise ValueError("disableCache must be a boolean")
    if request.get("target") != {"kind": "c"} or request.get("executionBackend") != "cython":
        raise ValueError("This collector supports target='c', executionBackend='cython'")
    return request


def execute(request: dict, writer: EventWriter) -> int:
    run = Run(request, writer)
    phase = "source"
    source_error = None
    try:
        entry = Path(str(request.get("entryPath", ""))).expanduser().resolve()
        run.record["entry"]["path"] = str(entry)
        with tokenize.open(entry) as source_file:
            run.record["entry"]["source"] = source_file.read()
    except BaseException as error:
        source_error = error
    # This event exists even if reading the entry or importing TileLang fails.
    writer.emit({"type": "record", "record": run.record})
    try:
        phase = "request"
        validate_request(request)
        phase = "source"
        if source_error is not None:
            raise source_error
        phase = "environment"
        # The selected interpreter must see both the workspace checkout and
        # entry-local helper modules, without requiring an editable install.
        workspace = str(Path.cwd())
        os.chdir(request["workingDirectory"])
        sys.path[:0] = [str(entry.parent), str(Path.cwd()), workspace]
        os.environ["TL_LOWER_TRACE"] = "0"
        os.environ["TILELANG_DEFAULT_TARGET"] = "c"
        os.environ["TILELANG_EXECUTION_BACKEND"] = "cython"
        if request["disableCache"]:
            os.environ["TILELANG_DISABLE_CACHE"] = "1"
        import tilelang
        from tilelang.tools.lower_trace import disable as disable_lower_trace

        disable_lower_trace()
        if request["disableCache"]:
            tilelang.disable_cache()
        environment = run.record["environment"]
        environment.update(tilelangVersion=str(tilelang.__version__), tilelangPath=str(Path(tilelang.__file__).resolve()))
        revision = tilelang_git_revision(tilelang.__file__)
        if revision is not None:
            environment["gitRevision"] = revision
        writer.emit({"type": "environment", "environment": environment})

        run.log("运行 Python 脚本 __main__，采集当前主线程的 CPU C/Cython JIT；子进程不注入采集器。\n")
        if request["disableCache"]:
            run.log("已通过 TileLang 官方开关禁用 kernel 缓存；@jit 装饰器局部缓存遵循当前 TileLang 行为，仍可能命中。\n")
        phase = "script"
        old_argv = sys.argv
        sys.argv = [str(entry), *request["scriptArgs"]]
        try:
            with JITObservation(run).installed():
                try:
                    runpy.run_path(str(entry), run_name="__main__")
                except SystemExit as error:
                    if error.code not in (None, 0):
                        raise
        finally:
            sys.argv = old_argv
        if run.rejection is not None:
            run.finish("failed", run.rejection)
            return 1
        if not run.record["kernels"]:
            run.log("脚本已正常结束，但没有观察到 CPU C/Cython JIT 编译或缓存调用；没有生成编译阶段。\n")
        if any(kernel["status"] == "cancelled" for kernel in run.record["kernels"]):
            run.finish("cancelled", run.last_error)
            return 130
        if any(kernel["status"] == "failed" for kernel in run.record["kernels"]):
            run.finish("failed", run.last_error)
            return 1
        run.finish("succeeded")
        return 0
    except BaseException as error:
        cancelled = isinstance(error, KeyboardInterrupt)
        status = "cancelled" if cancelled else "failed"
        failure = error_info(error, phase)
        failure["traceback"] = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        if run.last_error is not None and run.last_error["message"] == failure["message"]:
            failure.update(run.last_error)
        elif run.rejection is not None and run.rejection["message"] == failure["message"]:
            failure["phase"] = run.rejection["phase"]
        run.finish(status, failure)
        if not cancelled:
            print(failure["traceback"], file=sys.stderr, end="")
        return 130 if cancelled else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--events", required=True, type=Path)
    args = parser.parse_args(argv)
    writer = EventWriter(args.events)
    previous_handler = signal.getsignal(signal.SIGINT)

    def interrupt(_signum, _frame):
        raise KeyboardInterrupt("Compilation cancelled")

    signal.signal(signal.SIGINT, interrupt)
    try:
        try:
            def reject_nonfinite(value):
                raise ValueError(f"Request contains non-finite JSON number: {value}")

            request = json.loads(args.request.read_text(encoding="utf-8"), parse_constant=reject_nonfinite)
            if not isinstance(request, dict):
                raise ValueError("Request must be a JSON object")
        except (OSError, ValueError, KeyboardInterrupt) as error:
            request = {
                "id": str(uuid4()), "entryPath": "", "scriptArgs": [], "workingDirectory": str(Path.cwd()),
                "target": {"kind": "c"}, "executionBackend": "cython", "disableCache": False,
            }
            run = Run(request, writer)
            writer.emit({"type": "record", "record": run.record})
            failure = error_info(error, "request")
            failure["traceback"] = traceback.format_exc()
            cancelled = isinstance(error, KeyboardInterrupt)
            run.finish("cancelled" if cancelled else "failed", failure)
            return 130 if cancelled else 1
        return execute(request, writer)
    finally:
        signal.signal(signal.SIGINT, previous_handler)
        writer.close()


if __name__ == "__main__":
    raise SystemExit(main())
