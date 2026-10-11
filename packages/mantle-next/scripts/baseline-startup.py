"""Local Linux/POSIX workerd proxy, not Cloudflare startup_time_ms.

Usage: python3 scripts/baseline-startup.py /installed/workerd /footprint-evidence
Fresh process per sample; no database or cloud resources. CPU includes process
startup, health, two contract-only requests and shutdown, including trace cost.
Keep raw traces for attribution; HTTP wall time is not pure JavaScript CPU.
"""
import hashlib
import http.client
import json
import os
import resource
import signal
import socket
import statistics
import subprocess
import sys
import time
from pathlib import Path

binary, root = Path(sys.argv[1]), Path(sys.argv[2])
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 9089))  # Fail if another server could answer probes.
output = root / "startup"
output.mkdir(exist_ok=False)
variants = ["whole-before", "whole-after", "select-direct", "native-selected", "native-aa", "direct-100", "driver-only"]
rows = []
for target in ["cloudflare-d1", "cloudflare-postgres"]:
    for sample in range(12):
        for variant in variants[sample % len(variants):] + variants[:sample % len(variants)]:
            app = root / target / ("native-selected" if variant == "native-aa" else variant)
            folder = output / f"{target}-{sample}-{variant}"
            folder.mkdir()
            bundle = app / "bundle/worker.js"
            config = folder / "local.capnp"
            config.write_text('using Workerd = import "/workerd/workerd.capnp";\nconst config :Workerd.Config = (services=[(name="app",worker=(modules=[(name="worker.js",esModule=embed ' + json.dumps(os.path.relpath(bundle, folder)) + ')],compatibilityDate="2026-09-28",compatibilityFlags=["nodejs_compat"]))],sockets=[(name="http",address="127.0.0.1:9089",http=(),service="app")]);')
            before = resource.getrusage(resource.RUSAGE_CHILDREN)
            start = time.perf_counter_ns()
            with (folder / "workerd.log").open("wb") as log:
                child = subprocess.Popen([str(binary), "serve", str(config), "--perfetto-trace=" + str(folder / "trace.pftrace") + "=v8,workerd"], stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 10
                    while True:
                        assert child.poll() is None, (folder / "workerd.log").read_text()
                        try:
                            with socket.create_connection(("127.0.0.1", 9089), timeout=0.1):
                                break
                        except OSError:
                            assert time.monotonic() < deadline, "workerd readiness timeout"
                            time.sleep(0.001)
                    ready_ms = (time.perf_counter_ns() - start) / 1e6
                    timings = []
                    for path in ["/health", "/health" if variant == "driver-only" else "/contract", "/health" if variant == "driver-only" else "/contract"]:
                        connection = http.client.HTTPConnection("127.0.0.1", 9089, timeout=10)
                        tick = time.perf_counter_ns()
                        connection.request("GET", path)
                        response = connection.getresponse()
                        body = response.read()
                        timings.append((time.perf_counter_ns() - tick) / 1e6)
                        assert response.status == 200, body
                        if path == "/contract":
                            expected = [{"requestCount": "2", "totalAmount": "15.5"}] if target == "cloudflare-postgres" and variant != "whole-before" else [{"requestCount": 2, "totalAmount": 15.5}]
                            assert json.loads(body) == expected, body
                        connection.close()
                finally:
                    child.send_signal(signal.SIGINT)
                    child.wait(timeout=10)
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            row = dict(target=target, variant=variant, sample=sample,
                       bundleSHA256=hashlib.sha256(bundle.read_bytes()).hexdigest(),
                       processCPUms=((after.ru_utime-before.ru_utime)+(after.ru_stime-before.ru_stime))*1000,
                       readyWallMs=ready_ms, firstContractHTTPms=timings[1], secondContractHTTPms=timings[2])
            rows.append(row)
            (folder / "sample.json").write_text(json.dumps(row, indent=2))
        print(json.dumps(dict(target=target, pairedRound=sample+1)), flush=True)
summary = []
for target in ["cloudflare-d1", "cloudflare-postgres"]:
    for variant in variants:
        selected = [row for row in rows if row["target"] == target and row["variant"] == variant]
        summary.append(dict(target=target,variant=variant,samples=len(selected),**{key:statistics.median(row[key] for row in selected) for key in ["processCPUms","readyWallMs","firstContractHTTPms","secondContractHTTPms"]}))
(output / "results.json").write_text(json.dumps(dict(rows=rows,summary=summary), indent=2))
print(json.dumps(summary, indent=2))
# A regression watchdog, not an equivalence test. Native A/A differences set
# the noise allowance; keep a small absolute floor for these short local probes.
for target in ["cloudflare-d1", "cloudflare-postgres"]:
    measured = {row["variant"]:row for row in summary if row["target"] == target}
    for metric, floor in [("processCPUms", 5), ("firstContractHTTPms", 0.5)]:
        native_a, native_b = measured["native-selected"][metric], measured["native-aa"][metric]
        native = (native_a + native_b) / 2
        allowance = max(floor, 2 * abs(native_a-native_b))
        assert measured["select-direct"][metric] <= native * 1.10 + allowance, (target, metric, "local cold regression")
    assert measured["whole-after"]["processCPUms"] <= measured["whole-before"]["processCPUms"] * 1.10 + 5, (target, "whole native startup regression")
