#!/usr/bin/env python3
import asyncio
import json
import os
import shlex
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field
from pydantic_ai import Agent, ModelResponse, UsageLimits
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


def build_model(config: dict[str, Any]):
    kind = config.get("kind")
    if kind == "test":
        step = {"value": 0}

        def deterministic_model(messages, info):
            state = config.get("_debugState")
            if isinstance(state, dict):
                state["modelCalls"] = state.get("modelCalls", 0) + 1
                state["functionTools"] = [tool.name for tool in (info.function_tools or [])]
                state["outputTools"] = [tool.name for tool in (info.output_tools or [])]
                state["messageCount"] = len(messages)
            if step["value"] == 0:
                step["value"] = 1
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
    root = resolve_workspace(params.get("workspace"))
    state["workspace"] = str(root)
    state["lastActivityAt"] = time.monotonic()

    model_config = dict(params.get("modelConfig") or {})
    model_config["_debugState"] = state
    model = build_model(model_config)
    role = str(params.get("role") or "role")
    prompt = str(params.get("prompt") or "")
    instructions = (
        f"You are the Ariad {role} role. Work only inside the provided workspace. "
        "Use tools as needed. When the work is complete, return the required structured RoleResult. "
        "Do not invent files, commands, tests, or evidence."
    )
    agent = Agent(model, instructions=instructions, output_type=RoleResult)

    def touch() -> None:
        state["lastActivityAt"] = time.monotonic()

    @agent.tool_plain
    def workspace_probe() -> str:
        """List the workspace root so the agent can orient itself before acting."""
        touch()
        names = sorted(item.name for item in root.iterdir())
        return "\n".join(names[:200])

    @agent.tool_plain
    def read_file(path: str) -> str:
        """Read one UTF-8 text file relative to the workspace."""
        touch()
        target = jailed_path(root, path)
        return target.read_text(encoding="utf-8")

    @agent.tool_plain
    def write_file(path: str, content: str) -> str:
        """Write one UTF-8 text file relative to the workspace, creating parent directories."""
        touch()
        target = jailed_path(root, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"wrote {target.relative_to(root)}"

    @agent.tool_plain
    def exec_command(command: str, timeout_seconds: int = 120) -> str:
        """Execute a shell command in the workspace and return exit code plus captured stdout/stderr."""
        touch()
        timeout_seconds = max(1, min(int(timeout_seconds), 600))
        completed = subprocess.run(
            command,
            cwd=root,
            shell=True,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
        )
        return json.dumps({
            "exitCode": completed.returncode,
            "stdout": completed.stdout[-20000:],
            "stderr": completed.stderr[-20000:],
        })

    try:
        result = await agent.run(prompt, usage_limits=UsageLimits(request_limit=8))
        output = result.output
        if not isinstance(output, RoleResult):
            output = RoleResult.model_validate(output)
        state["state"] = "COMPLETED"
        state["result"] = output.model_dump()
        usage = getattr(result, "usage", None)
        if callable(usage):
            usage = usage()
        state["usage"] = usage.model_dump(mode="json") if hasattr(usage, "model_dump") else (str(usage) if usage is not None else None)
    except asyncio.CancelledError:
        state["state"] = "CANCELLED"
        state["failure"] = "PYDANTIC_RUN_CANCELLED"
        raise
    except Exception as exc:
        state["state"] = "FAILED"
        state["failure"] = f"{type(exc).__name__}: {exc}"


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
            "debug": {
                key: state.get(key)
                for key in ("modelCalls", "functionTools", "outputTools", "messageCount", "lastModelAction")
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
