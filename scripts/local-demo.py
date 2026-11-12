"""Local-only demo launcher. No provisioning, downloads or credential copies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PORTS = {"mysql": 13316, "backend": 8080, "model": 5001, "web": 5173}
MODEL_WEIGHTS = ROOT / "model-service/weights"
ENV_KEYS = {"DB_URL", "DB_USERNAME", "DB_PASSWORD", "V2_JWT_SECRET", "JWT_SECRET",
            "MODEL_INTERNAL_TOKEN", "V2_JWT_EXPIRE_HOURS", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
            "PILOT_REGISTRATION_CODE", "PILOT_OPERATOR", "PILOT_CONTACT", "PILOT_PRIVACY_VERSION"}


def private_environment(filename):
    if not filename:
        return {}
    path = Path(filename)
    if not path.is_file() or path.stat().st_size > 65536:
        raise ValueError("Provide an existing private JSON environment file <=64 KiB")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Environment file must be a JSON object")
    result = {}
    for key in ENV_KEYS:
        if key in data:
            value = data[key]
            if not isinstance(value, str) or len(value) > 8192 or "\0" in value:
                raise ValueError("Invalid private environment value; contents suppressed")
            result[key] = value
    return result


def listening(port):
    with socket.socket() as connection:
        connection.settimeout(.5)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def executable(value, fallback, description):
    name = value or shutil.which(fallback)
    if not name or not Path(name).is_file():
        raise ValueError("Provide an existing executable for " + description)
    return str(Path(name).resolve())


def environment(args):
    env = dict(os.environ, **private_environment(args.env_file))
    env.update({"SERVER_ADDRESS": "127.0.0.1", "SERVER_PORT": "8080",
                "HOST": "127.0.0.1", "PORT": "5001", "MODEL_SERVICE_URL": "http://127.0.0.1:5001",
                "MODEL_REGISTRY_PATH": str(MODEL_WEIGHTS / "registry.json"),
                "WEIGHTS_DIR": str(MODEL_WEIGHTS),
    # 平台状态页要现场探测 Redis 与训练 worker，缺这两项会显示 REDIS DOWN
    "REDIS_HOST": "127.0.0.1",
    "REDIS_PORT": "16379",
                "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
                "HDR_LEGACY_AUTH_ENABLED": "false", "HDR_LEGACY_BOOTSTRAP_ENABLED": "false",
                "SPRING_PROFILES_ACTIVE": "default" if args.allow_development_registration else "pilot",
                "HDR_PILOT_ENABLED": "false" if args.allow_development_registration else "true",
                "VITE_APP_MODE": "development" if args.allow_development_registration else "pilot"})
    for field in ("OPERATOR", "CONTACT", "PRIVACY_VERSION"):
        env["VITE_PILOT_" + field] = env.get("PILOT_" + field, "")
    return env


def command(args, env):
    if args.service == "mysql":
        binary = executable(args.mysqld, "mysqld", "mysqld")
        base = Path(binary).parent.parent
        data = Path(args.mysql_data or "")
        if not args.mysql_data or not data.is_dir() or not (data / "auto.cnf").is_file():
            raise ValueError("Supply an existing initialized MySQL data directory; this tool never initializes one")
        return [binary, "--no-defaults", "--basedir=" + str(base), "--datadir=" + str(data.resolve()),
                "--bind-address=127.0.0.1", "--port=13316", "--mysqlx=OFF", "--default-time-zone=+00:00", "--console"]
    if args.service == "backend":
        if not listening(PORTS["mysql"]):
            raise ValueError("Start the isolated database first (127.0.0.1:13316)")
        if not re.match(r"^jdbc:mysql://127\.0\.0\.1:13316/[A-Za-z0-9_]+(?:\?|$)", env.get("DB_URL", "")):
            raise ValueError("Local demo DB_URL must name a database on 127.0.0.1:13316")
        if not env.get("DB_USERNAME") or not env.get("V2_JWT_SECRET"):
            raise ValueError("Database identity and V2_JWT_SECRET must be supplied privately")
        java = args.java
        if not java and env.get("JAVA_HOME"):
            java = str(Path(env["JAVA_HOME"]) / "bin" / ("java.exe" if os.name == "nt" else "java"))
        jar = ROOT / "backend/target/hdr-backend-0.1.0-SNAPSHOT.jar"
        if not jar.is_file():
            raise ValueError("Build backend with Maven verify first")
        return [executable(java, "java", "Java 17"), "-jar", str(jar)]
    if args.service == "model":
        if not env.get("MODEL_INTERNAL_TOKEN"):
            raise ValueError("MODEL_INTERNAL_TOKEN must be supplied privately")
        return [executable(args.python or sys.executable, "python", "inference Python"), "-I", str(ROOT / "model-service/serve.py")]
    if args.service == "web":
        entry = ROOT / "frontend/node_modules/vite/bin/vite.js"
        if not entry.is_file():
            raise ValueError("Existing frontend dependencies are required; this tool does not install them")
        return [executable(args.node, "node", "Node 22+"), str(entry), str(ROOT / "frontend"),
                "--host", "127.0.0.1", "--port", "5173", "--strictPort"]
    raise ValueError("Unsupported service")


def fetch(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read(65537)
        if len(body) > 65536:
            raise ValueError("Health response exceeded limit")
        return response.status, body


def check(env):
    result = {name: {"tcpListening": listening(port)} for name, port in PORTS.items()}
    result["mysql"]["sqlChecked"] = False  # A listener is not proof of database credentials or schema health.
    try:
        _, raw = fetch("http://127.0.0.1:8080/api/health")
        body = json.loads(raw)
        result["backend"]["liveness"] = body.get("code") == 0 and body.get("data", {}).get("status") == "UP"
    except Exception:
        result["backend"]["liveness"] = False
    try:
        if not env.get("MODEL_INTERNAL_TOKEN"):
            raise ValueError("Missing internal token")
        _, raw = fetch("http://127.0.0.1:5001/internal/v2/ready", {"X-HDR-Internal-Token": env["MODEL_INTERNAL_TOKEN"]})
        body = json.loads(raw)
        data = body.get("data", {}) if body.get("code") == 0 else {}
        # 多模型：只要注册表里至少有一个通过摘要校验的模型就算可信就绪。
        result["model"]["trustedReady"] = data.get("status") == "UP" and int(data.get("verifiedModels", 0)) >= 1
        result["model"]["verifiedModels"] = int(data.get("verifiedModels", 0))
    except Exception:
        result["model"]["trustedReady"] = False
    try:
        _, raw = fetch("http://127.0.0.1:5173/")
        result["web"]["entrypoint"] = b"Digit Studio" in raw and b"/src/main.js" in raw
    except Exception:
        result["web"]["entrypoint"] = False
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("Listener/liveness checks do not replace registration, inference or WeChat device acceptance.")
    return 0 if all(value["tcpListening"] for value in result.values()) and result["backend"]["liveness"] and result["model"]["trustedReady"] and result["web"]["entrypoint"] else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("service", choices=["mysql", "backend", "model", "web", "check"])
    parser.add_argument("--env-file", help="Existing private environment JSON, read in memory only")
    parser.add_argument("--allow-development-registration", action="store_true", help="Explicit local-only opt-in: no pilot registration code required")
    parser.add_argument("--java")
    parser.add_argument("--python")
    parser.add_argument("--node")
    parser.add_argument("--mysqld")
    parser.add_argument("--mysql-data")
    parser.add_argument("--mysqladmin", help="Optional trusted mysqladmin for clean Ctrl+C shutdown")
    parser.add_argument("--client-options", help="Existing private mysqladmin option file; never copied or printed")
    args = parser.parse_args(argv)
    env = environment(args)
    if args.service == "check":
        return check(env)
    port = PORTS[args.service]
    if listening(port):
        raise ValueError(f"Port {port} is already in use; inspect/check it, no process was stopped")
    cmd = command(args, env)
    print(f"Starting {args.service} on 127.0.0.1:{port}; keep this terminal open.", flush=True)
    if args.allow_development_registration:
        print("Local development admission explicitly enabled; no public deployment config was changed.", flush=True)
    process = subprocess.Popen(cmd, cwd=ROOT, env=env)
    try:
        return process.wait()
    except KeyboardInterrupt:
        if process.poll() is None:
            if args.service == "mysql":
                if not args.mysqladmin or not args.client_options:
                    print("Use mysqladmin with your private option file to shut down MySQL cleanly; no forced termination was attempted.")
                    return 130
                options = Path(args.client_options)
                if not options.is_file():
                    raise ValueError("Existing private mysqladmin option file required")
                shutdown = [executable(args.mysqladmin, "mysqladmin", "mysqladmin"),
                            "--defaults-file=" + str(options.resolve()), "--host=127.0.0.1", "--port=13316", "--protocol=TCP", "shutdown"]
                if subprocess.call(shutdown, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL):
                    raise ValueError("MySQL clean shutdown failed; the server was not forcibly terminated")
            else:
                process.terminate()
            process.wait(timeout=15)
        return 130


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except json.JSONDecodeError:
        raise SystemExit("Private environment JSON is invalid; contents suppressed.")
    except ValueError as error:
        raise SystemExit(str(error))
    except (OSError, subprocess.TimeoutExpired):
        raise SystemExit("Local demo operation failed. Check paths/config/ports; credentials and underlying errors are suppressed.")
