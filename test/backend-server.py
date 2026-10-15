"""Isolated real Sovara backend for the optional integration test. No model calls."""

import os
import socket
import tempfile
from unittest.mock import patch

task_home = tempfile.TemporaryDirectory(prefix="pi-sovara-backend-")
original_expanduser = os.path.expanduser


def isolated_expanduser(path):
    if path == "~":
        return task_home.name
    if path.startswith("~/"):
        return os.path.join(task_home.name, path[2:])
    return original_expanduser(path)


# Isolate filesystem resolution without changing the calling user's HOME.
patch("os.path.expanduser", isolated_expanduser).start()
os.environ["SOVARA_AUTH_MODE"] = "local"
os.environ["SOVARA_DB_BACKEND"] = "sqlite"
os.environ["SOVARA_DISABLE_DEFAULT_DB_SEED"] = "1"

import uvicorn
from sovara_exec_server.app import create_app
from sovara_server_common.database import DB

app = create_app(disable_inactivity_timeout=True)


@app.get("/health/test-run/{run_id}")
def inspect(run_id: str):
    return DB.get_run_tree(run_id, with_turns=True).model_dump(mode="json")


sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(f"http://127.0.0.1:{sock.getsockname()[1]}", flush=True)
try:
    uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[sock])
finally:
    task_home.cleanup()
