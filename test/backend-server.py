"""Isolated real Sovara backend for the optional integration test. No model calls."""

import json
import os
import socket
import tempfile
from unittest.mock import patch
from uuid import uuid4

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
from sovara_server_common.stream_reconstruction import effective_output_to_show

from sovara_server_common.lessons_backend.storage import LessonStore
from sovara_app_server.routes.ui_runs import (
    _get_lesson_retrieval_rows_for_run,
    _lesson_retrieval_list_row,
    _lesson_retrieval_list_payload,
    _lesson_retrieval_detail_payload,
    resolve_lesson_records,
)

app = create_app(disable_inactivity_timeout=True)


@app.post("/health/test-lessons/{project_id}")
def seed_lessons(project_id: str):
    store = LessonStore(project_id)
    examples = [
        ("Portfolio restrictions", "Limit sector exposure.", "Keep sector exposure below 5%."),
        ("Portfolio horizon", "Check the investment horizon.", "Ask when the money is needed."),
    ]
    return [
        store.create(str(uuid4()), title, summary, content)
        for title, summary, content in examples
    ]


@app.get("/health/test-run/{run_id}")
def inspect(run_id: str):
    tree = DB.get_run_tree(run_id, with_turns=True).model_dump(mode="json")
    for step in tree["steps"]:
        if step.get("output_json"):
            step["display_output"] = effective_output_to_show(
                json.loads(step["output_json"]), step["api_type"], rebuild_from_raw=True
            )
    records = _get_lesson_retrieval_rows_for_run(run_id)
    project_id = DB.get_run_scope(run_id)["project_id"]
    rows = [_lesson_retrieval_list_row(record) for record in records]
    resolved = resolve_lesson_records(
        (entry for row in rows for entry in row["applied_lessons"]), project_id
    )
    tree["lesson_badges"] = [_lesson_retrieval_list_payload(row, resolved) for row in rows]
    tree["lesson_details"] = [
        _lesson_retrieval_detail_payload(record, project_id=project_id) for record in records
    ]
    return tree


sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(f"http://127.0.0.1:{sock.getsockname()[1]}", flush=True)
try:
    uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[sock])
finally:
    task_home.cleanup()
