#!/usr/bin/env python3
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelMessagesTypeAdapter, ModelResponse
from pydantic_ai.messages import ToolCallPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider


class RoleResult(BaseModel):
    outcome: str
    summary: str
    keyPoints: list[str] = Field(default_factory=list)
    artifacts: list[str] = Field(default_factory=list)
    result: Any = None


runs: dict[str, dict[str, Any]] = {}
tasks: dict[str, asyncio.Task] = {}


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def resolve_workspace(raw: Any) -> Path:
    root = Path(str(raw or os.getcwd())).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError(f"workspace does not exist: {root}")
    return root


def jailed_path(root: Path, raw: str) -> Path:
    candidate = (root / raw).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"path escapes workspace: {raw}") from exc
    return candidate



def session_history_path(root: Path, session_key: str) -> Path:
    digest = hashlib.sha256(session_key.encode("utf-8")).hexdigest()
    return root / ".ariad" / "memory" / "sessions" / f"{digest}.json"


def load_session_history(root: Path, session_key: str):
    path = session_history_path(root, session_key)
    if not path.exists():
        return None
    return ModelMessagesTypeAdapter.validate_json(path.read_bytes())


def save_session_history(root: Path, session_key: str, payload: bytes) -> None:
    path = session_history_path(root, session_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(payload)
    tmp.replace(path)

def build_model(config: dict[str, Any]):
    kind = config.get("kind")
    if kind == "test":
        step = {"value": 0}
        scenario = config.get("scenario", "tool-then-result")

        def deterministic_model(messages, info):
            state = config.get("_debugState")
            step["value"] += 1
            if isinstance(state, dict):
                state["modelCalls"] = state.get("modelCalls", 0) + 1
                state["lastActivityAt"] = time.monotonic()
                state["lastActivityType"] = "model_response"
                state["functionTools"] = [tool.name for tool in (info.function_tools or [])]
                state["outputTools"] = [tool.name for tool in (info.output_tools or [])]
                state["messageCount"] = len(messages)

            if scenario == "empty-once" and step["value"] == 1:
                if isinstance(state, dict):
                    state["lastModelAction"] = "empty"
                return ModelResponse(parts=[])

            if scenario == "empty-always":
                if isinstance(state, dict):
                    state["lastModelAction"] = "empty"
                return ModelResponse(parts=[])

            if scenario == "stall":
                time.sleep(float(config.get("stallSeconds", 5)))
                return ModelResponse(parts=[])

            if scenario == "long-command" and step["value"] == 1:
                if isinstance(state, dict):
                    state["lastModelAction"] = "exec_command"
                return ModelResponse(parts=[ToolCallPart("exec_command", {
                    "command": config.get("command", "sleep 5"),
                    "timeout_seconds": int(config.get("timeoutSeconds", 10)),
                })])

            if scenario == "tool-then-result" and step["value"] == 1:
                if isinstance(state, dict):
                    state["lastModelAction"] = "workspace_probe"
                return ModelResponse(parts=[ToolCallPart("workspace_probe", {})])

            if not info.output_tools:
                raise RuntimeError("Pydantic AI did not expose a structured output tool")
            output_tool_name = info.output_tools[0].name
            if isinstance(state, dict):
                state["lastModelAction"] = f"output:{output_tool_name}"
            return ModelResponse(parts=[ToolCallPart(output_tool_name, {
                "outcome": config.get("outcome", "PASS"),
                "summary": config.get("summary", "Pydantic runtime test completed."),
                "keyPoints": ["pydantic-ai-agent-loop"],
                "artifacts": [],
                "result": {"backend": "test"},
            })])

        return FunctionModel(deterministic_model)
    if kind == "openai-compatible":
        model_name = config.get("model")
        base_url = config.get("baseUrl")
        if not model_name or not base_url:
            raise ValueError("openai-compatible model requires model and baseUrl")
        api_key = config.get("apiKey")
        if not api_key:
            env_name = config.get("apiKeyEnv")
            api_key = os.getenv(env_name, "") if env_name else ""
        return OpenAIChatModel(
            model_name,
            provider=OpenAIProvider(
                base_url=base_url,
                api_key=api_key or "not-needed",
            ),
        )
    raise ValueError(f"unsupported Pydantic model kind: {kind}")


async def execute_run(external_id: str, params: dict[str, Any]) -> None:
    state = runs[external_id]
    state["state"] = "RUNNING"
    try:
        state["phase"] = "resolve-workspace"
        root = resolve_workspace(params.get("workspace"))
        state["workspace"] = str(root)
        state["lastActivityAt"] = time.monotonic()
        state["lastActivityType"] = "run_start"
        state["executionContext"] = {
            "readFiles": [],
            "writtenFiles": [],
            "commands": [],
        }

        model_config = dict(params.get("modelConfig") or {})
        model_config["_debugState"] = state
        state["phase"] = "build-model"
        model = build_model(model_config)
        role = str(params.get("role") or "role")
        prompt = str(params.get("prompt") or "")
        session_policy = str(params.get("sessionPolicy") or "fresh")
        session_key = str(params.get("sessionKey") or "").strip()
        message_history = None
        if session_policy == "persistent":
            if not session_key:
                raise ValueError("persistent session requires sessionKey")
            state["sessionKey"] = session_key
            state["phase"] = "load-history"
            message_history = load_session_history(root, session_key)
            state["historyMessages"] = len(message_history or [])
        instructions = (
            f"You are the Ariad {role} role. Work only inside the provided workspace. "
            "At every step, take exactly one kind of meaningful action: call an available tool to make or verify progress, "
            "or, if and only if the assigned work is actually complete, return the required structured RoleResult. "
            "A tool result never means the task is complete by itself; after every tool result, reassess the task and continue "
            "with another tool when more work or verification is needed. "
            "Do not stop merely to summarize progress. Do not use ordinary prose as a final answer. "
            "Do not invent files, commands, tests, or evidence."
        )

        state["phase"] = "construct-agent"
        agent = Agent(model, instructions=instructions, output_type=RoleResult, retries={"output": 1, "tools": 3})
        state["phase"] = "register-tools"

        def touch(activity_type: str) -> None:
            state["lastActivityAt"] = time.monotonic()
            state["lastActivityType"] = activity_type

        def remember_list(key: str, value: Any, limit: int) -> None:
            context = state["executionContext"]
            items = context[key]
            if value in items:
                items.remove(value)
            items.append(value)
            if len(items) > limit:
                del items[:-limit]

        @agent.tool_plain
        def workspace_probe() -> str:
            """List the workspace root so the agent can orient itself before acting."""
            touch("tool:workspace_probe")
            names = sorted(item.name for item in root.iterdir())
            return "\n".join(names[:200])

        read_cache: dict[str, tuple[int, int, str]] = {}

        @agent.tool_plain
        def search_code(pattern: str, paths: list[str] | None = None, max_results: int = 80) -> str:
            """Search code/text with ripgrep. Prefer this before broad file reads. Paths are workspace-relative."""
            touch("tool:search_code")
            max_results = max(1, min(int(max_results), 200))
            safe_paths = []
            for raw in paths or ["."]:
                target = jailed_path(root, raw)
                safe_paths.append(str(target.relative_to(root)) if target != root else ".")
            command = ["rg", "-n", "--no-heading", "--color", "never", pattern, *safe_paths]
            completed = subprocess.run(
                command,
                cwd=root,
                text=True,
                capture_output=True,
                timeout=30,
            )
            lines = completed.stdout.splitlines()[:max_results]
            remember_list("commands", {
                "command": " ".join(command)[:1000],
                "exitCode": completed.returncode,
            }, 24)
            if completed.returncode not in (0, 1):
                raise RuntimeError(completed.stderr[-4000:])
            return "\n".join(lines)

        @agent.tool_plain
        def read_file(path: str, start_line: int = 1, end_line: int | None = None) -> str:
            """Read a bounded UTF-8 line range. Default returns at most 400 lines; request another range if needed."""
            touch("tool:read_file")
            target = jailed_path(root, path)
            relative = str(target.relative_to(root))
            remember_list("readFiles", relative, 48)

            start_line = max(1, int(start_line))
            if end_line is None:
                end_line = start_line + 399
            end_line = max(start_line, min(int(end_line), start_line + 399))

            stat = target.stat()
            cache_key = f"{relative}:{start_line}:{end_line}"
            fingerprint = f"{stat.st_mtime_ns}:{stat.st_size}"
            cached = read_cache.get(cache_key)
            if cached and cached[2] == fingerprint:
                return (
                    f"UNCHANGED: {relative} lines {start_line}-{end_line} were already read "
                    "in this run and the file has not changed. Use the previous tool result."
                )

            lines = target.read_text(encoding="utf-8").splitlines()
            selected = lines[start_line - 1:end_line]
            read_cache[cache_key] = (start_line, end_line, fingerprint)
            body = "\n".join(
                f"{line_no}: {text}"
                for line_no, text in enumerate(selected, start=start_line)
            )
            if end_line < len(lines):
                body += f"\n... ({len(lines) - end_line} more lines; request a later range if needed)"
            return body

        @agent.tool_plain
        def write_file(path: str, content: str) -> str:
            """Write one UTF-8 text file relative to the workspace, creating parent directories."""
            touch("tool:write_file")
            target = jailed_path(root, path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            relative = str(target.relative_to(root))
            remember_list("writtenFiles", relative, 32)
            return f"wrote {relative}"

        @agent.tool_plain
        async def exec_command(command: str, timeout_seconds: int = 120) -> str:
            """Execute a shell command in the workspace and return exit code plus captured stdout/stderr."""
            touch("tool:exec_command:start")
            timeout_seconds = max(1, min(int(timeout_seconds), 600))
            command_record = {"command": command[:1000], "exitCode": None}
            remember_list("commands", command_record, 24)
            process = await asyncio.create_subprocess_shell(
                command,
                cwd=root,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                raise TimeoutError(f"command timed out after {timeout_seconds}s: {command}")
            touch("tool:exec_command:end")
            command_record["exitCode"] = process.returncode
            return json.dumps({
                "exitCode": process.returncode,
                "stdout": stdout.decode(errors="replace")[-12000:],
                "stderr": stderr.decode(errors="replace")[-8000:],
            })

        async def run_with_idle_watchdog():
            idle_timeout = float(params.get("idleTimeoutSeconds") or 600)
            check_interval = min(max(idle_timeout / 10.0, 0.05), 5.0)
            run_task = asyncio.create_task(agent.run(
                prompt,
                message_history=message_history,
            ))
            while True:
                done, _ = await asyncio.wait({run_task}, timeout=check_interval)
                if run_task in done:
                    return await run_task
                idle_for = time.monotonic() - float(state.get("lastActivityAt") or time.monotonic())
                if idle_for >= idle_timeout:
                    run_task.cancel()
                    try:
                        await run_task
                    except asyncio.CancelledError:
                        pass
                    raise TimeoutError(
                        f"IDLE_TIMEOUT: no model/tool activity for {idle_for:.1f}s "
                        f"(limit {idle_timeout:.1f}s, last={state.get('lastActivityType', 'unknown')})"
                    )

        state["phase"] = "before-run"
        result = await run_with_idle_watchdog()
        state["phase"] = "after-run"

        output = result.output
        if not isinstance(output, RoleResult):
            output = RoleResult.model_validate(output)
        state["state"] = "COMPLETED"
        state["result"] = output.model_dump()
        usage = getattr(result, "usage", None)
        if callable(usage):
            usage = usage()
        state["usage"] = (
            usage.model_dump(mode="json")
            if hasattr(usage, "model_dump")
            else (str(usage) if usage is not None else None)
        )
        if session_policy == "persistent":
            state["phase"] = "save-history"
            save_session_history(root, session_key, result.all_messages_json())
        state["phase"] = "completed"
    except asyncio.CancelledError:
        state["state"] = "CANCELLED"
        state["failure"] = "PYDANTIC_RUN_CANCELLED"
        state["phase"] = "cancelled"
        raise
    except Exception as exc:
        state["state"] = "FAILED"
        state["failure"] = f"{type(exc).__name__}: {exc}"
        state["phase"] = "failed"


async def handle(method: str, params: dict[str, Any]) -> Any:
    if method == "start":
        external_id = str(uuid.uuid4())
        runs[external_id] = {
            "state": "QUEUED",
            "runId": params.get("runId"),
            "role": params.get("role"),
        }
        tasks[external_id] = asyncio.create_task(execute_run(external_id, params))
        return {"externalId": external_id, "runtimeId": "pydantic-ai"}

    if method == "poll":
        external_id = str(params.get("externalId") or "")
        state = runs.get(external_id)
        if state is None:
            return {"state": "LOST", "failure": "PYDANTIC_RUN_NOT_FOUND", "restartOrphan": True}
        status = {
            "state": state["state"],
            "executionContext": state.get("executionContext") or None,
            "debug": {
                key: state.get(key)
                for key in ("phase", "modelCalls", "functionTools", "outputTools", "messageCount", "lastModelAction", "lastActivityType", "historyMessages", "sessionKey")
                if key in state
            },
        }
        if state["state"] == "COMPLETED":
            role_result = state.get("result") or {}
            status.update({
                "outcome": role_result.get("outcome", "PASS"),
                "summary": role_result.get("summary", ""),
                "keyPoints": role_result.get("keyPoints", []),
                "artifacts": role_result.get("artifacts", []),
                "result": role_result.get("result"),
                "usage": state.get("usage"),
            })
        elif state["state"] in {"FAILED", "CANCELLED"}:
            status["failure"] = state.get("failure", "PYDANTIC_RUN_FAILED")
        return status

    if method == "cancel":
        external_id = str(params.get("externalId") or "")
        task = tasks.get(external_id)
        if task is None:
            return {"state": "NOT_FOUND", "confirmed": True}
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        return {"state": "CANCELLED", "confirmed": True}

    if method == "shutdown":
        for task in list(tasks.values()):
            if not task.done():
                task.cancel()
        return {"stopped": True}

    raise ValueError(f"unknown method: {method}")


async def main() -> None:
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = await handle(str(request.get("method")), request.get("params") or {})
            emit({"id": request_id, "ok": True, "result": result})
            if request.get("method") == "shutdown":
                break
        except Exception as exc:
            emit({"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    asyncio.run(main())
