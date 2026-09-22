#!/usr/bin/env python3
"""Authenticated local bridge for a host assistant's existing Slack/Jira/Figma tools.

Never reads connector credentials, invokes a model, writes external services, or prints the room token.
"""
import argparse
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Local bridge redirects are not allowed")


def connection(path):
    value = urlsplit(path.read_text().strip())
    tokens = parse_qs(value.query).get("token", [])
    if value.scheme != "http" or value.hostname != "127.0.0.1" or not value.port or value.username or value.password or len(tokens) != 1:
        raise ValueError("Expected the existing local Consensus Room launch URL")
    return f"http://127.0.0.1:{value.port}", tokens[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--launch-file", type=Path, default=Path.home() / "Library/Application Support/ConsensusRoom/consensus-room.url")
    parser.add_argument("command", choices=["due", "claim", "snapshot", "unchanged", "failure", "attach", "status", "batch", "ack", "connections", "use-rest", "metrics"])
    parser.add_argument("--id", help="source ID, or topic ID for attach/status")
    parser.add_argument("--input", type=Path, help="JSON file (do not place secret credentials here)")
    parser.add_argument("--session", help="실제 중재자 세션 ID; batch/ack에 필수")
    parser.add_argument("--batch", help="읽기를 마친 batchId; ack에 필수")
    args = parser.parse_args()
    base, token = connection(args.launch_file)
    if args.command not in {"due", "connections"} and not args.id:
        parser.error("--id is required")
    source_id = quote(args.id or "", safe="")
    route = {
        "due": "/api/evidence/due", "claim": f"/api/evidence/{source_id}/check",
        "snapshot": f"/api/evidence/{source_id}/snapshot", "unchanged": f"/api/evidence/{source_id}/unchanged",
        "failure": f"/api/evidence/{source_id}/failure", "attach": f"/api/topics/{source_id}/evidence/sources",
        "status": f"/api/topics/{source_id}/evidence",
        "connections": "/api/evidence/connections", "use-rest": f"/api/evidence/{source_id}/use-rest",
        "batch": f"/api/topics/{source_id}/evidence/mediator/batch",
        "ack": f"/api/topics/{source_id}/evidence/mediator/ack",
        "metrics": f"/api/topics/{source_id}/evidence/metrics",
    }[args.command]
    data = None
    if args.command not in {"due", "status", "connections", "metrics"}:
        if args.command in {"claim", "use-rest"}:
            data = b"{}"
        elif args.command in {"batch", "ack"}:
            if not args.session or (args.command == "ack" and not args.batch):
                parser.error("batch/ack에는 --session, ack에는 --batch가 필요합니다")
            data = json.dumps({"sessionId": args.session, **({"batchId": args.batch} if args.command == "ack" else {})}).encode()
        else:
            if not args.input:
                parser.error("--input is required")
            if args.input.stat().st_size > 16_000_000:
                parser.error("input exceeds the source limit")
            data = json.dumps(json.loads(args.input.read_text()), ensure_ascii=False).encode()
    request = Request(base + route, data=data, method="GET" if data is None else "POST", headers={
        "x-consensus-token": token, "x-consensus-actor": "mediator", "content-type": "application/json",
    })
    try:
        with build_opener(NoRedirect).open(request, timeout=200) as response:
            result = json.load(response)
    except HTTPError as error:
        # Server errors can contain operator data; return only code, no request headers/URL token.
        raise ValueError(f"Consensus Room returned HTTP {error.code}") from None
    # Only an explicit batch request returns changed source text. No command acknowledges it automatically.
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
