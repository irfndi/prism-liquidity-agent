"""LangChain tool for Prism liquidity agent.

Provides a LangChain BaseTool that wraps the Prism CLI for use in
agent workflows. All commands are thin subprocess wrappers around the
`prism` binary, matching the same patterns as the MCP server.

Usage:
    from langchain_prism import PrismTool

    tool = PrismTool()
    result = tool.run("status")
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

__all__ = ["PrismTool", "PrismExecResult"]

DEFAULT_TIMEOUT_SECONDS = 30
BACKTEST_TIMEOUT_SECONDS = 120
MAX_OUTPUT_BYTES = 10 * 1024 * 1024  # 10 MB


class PrismExecResult:
    """Result of a prism CLI invocation."""

    __slots__ = ("ok", "stdout", "stderr", "exit_code", "timed_out")

    def __init__(
        self,
        ok: bool,
        stdout: str,
        stderr: str,
        exit_code: int,
        timed_out: bool = False,
    ) -> None:
        self.ok = ok
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        self.timed_out = timed_out

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
        }


def _find_prism_binary() -> str:
    """Locate the prism CLI binary.

    Resolution order (matches MCP server):
    1. PRISM_BIN env var
    2. ~/.local/bin/prism
    3. ~/.bun/bin/prism
    4. prism on PATH
    """
    env_bin = os.environ.get("PRISM_BIN")
    if env_bin:
        return env_bin

    home = Path.home()
    candidates = [
        home / ".local" / "bin" / "prism",
        home / ".bun" / "bin" / "prism",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    # Fall back to PATH lookup
    on_path = shutil.which("prism")
    if on_path:
        return on_path

    raise FileNotFoundError(
        "prism CLI not found. Install Prism first: "
        "curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash"
    )


def run_prism(
    args: list[str],
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> PrismExecResult:
    """Run a prism CLI command as a subprocess.

    Args:
        args: Command arguments (e.g. ["status"], ["backtest", "--days", "7"]).
        timeout_seconds: Maximum seconds to wait before killing the process.

    Returns:
        PrismExecResult with stdout, stderr, exit code, and status flags.
    """
    binary = _find_prism_binary()
    cmd = [binary] + args

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env={**os.environ, "FORCE_COLOR": "0"},
        )
        return PrismExecResult(
            ok=result.returncode == 0,
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.returncode,
            timed_out=False,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", errors="replace") if exc.stdout else ""
        stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else ""
        return PrismExecResult(
            ok=False,
            stdout=stdout,
            stderr=stderr,
            exit_code=-1,
            timed_out=True,
        )
    except FileNotFoundError as exc:
        return PrismExecResult(
            ok=False,
            stdout="",
            stderr=f"Prism binary not found: {exc}. Set PRISM_BIN env var or install prism.",
            exit_code=-1,
        )
    except Exception as exc:
        return PrismExecResult(
            ok=False,
            stdout="",
            stderr=f"Unexpected error running prism: {exc}",
            exit_code=-1,
        )


class PrismToolInput(BaseModel):
    """Input for the Prism tool."""

    command: str = Field(
        description=(
            "The prism command to run. One of: "
            "'status', 'positions', 'backtest', 'setup', "
            "'whoami', 'wallet', 'update', 'version'. "
            "For backtest, pass args after a space: 'backtest --days 7'."
        ),
    )


class PrismTool(BaseTool):
    """LangChain tool that wraps the Prism liquidity agent CLI.

    Provides access to Prism commands (status, positions, backtest, setup, etc.)
    via subprocess calls. The tool finds the prism binary using the same
    resolution order as the MCP server.

    Usage:
        tool = PrismTool()
        result = tool.run("status")
        result = tool.run("backtest --days 7 --source replay")
    """

    name: str = "prism"
    description: str = (
        "Run Prism liquidity agent commands. "
        "Commands: 'status' (agent status + positions), "
        "'positions' (active positions), "
        "'backtest [--days N] [--source synthetic|replay]' (run backtest), "
        "'setup [--helius-key KEY] [--non-interactive]' (configure agent), "
        "'whoami' (cloud account info), "
        "'wallet show' (show wallet), "
        "'update' (self-update), "
        "'version' (current version)."
    )
    args_schema: type[BaseModel] = PrismToolInput

    def _run(self, command: str) -> str:
        """Execute a prism CLI command and return its output.

        Args:
            command: The full command string, e.g. "status" or "backtest --days 7".

        Returns:
            Command output as a string, or a JSON error object.
        """
        args = command.strip().split()
        if not args:
            return json.dumps({"error": "No command provided. Use: status, positions, backtest, setup, whoami, wallet, update, version"})

        subcommand = args[0]
        timeout = BACKTEST_TIMEOUT_SECONDS if subcommand == "backtest" else DEFAULT_TIMEOUT_SECONDS

        result = run_prism(args, timeout_seconds=timeout)

        if result.timed_out:
            return json.dumps({
                "error": f"Command 'prism {subcommand}' timed out after {timeout}s",
                "stderr": result.stderr,
            })

        if not result.ok:
            return json.dumps({
                "error": f"Command 'prism {subcommand}' failed (exit {result.exit_code})",
                "stdout": result.stdout,
                "stderr": result.stderr,
            })

        return result.stdout

    async def _arun(self, command: str) -> str:
        """Async variant — delegates to sync _run (subprocess is already non-blocking)."""
        return self._run(command)
