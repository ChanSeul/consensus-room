#!/usr/bin/env python3
"""Authenticated local bridge for a host assistant's existing Slack/Jira/Figma tools.

Never reads connector credentials, invokes a model, writes external services, or prints the room token.
"""
import argparse
import json
import os
from pathlib import Path
import re
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


def mediator_identity():
    """Assignment identity the mediator session was given (CONSENSUS_MEDIATOR=<participant>@<version>), same contract as cr_api.sh.

    Pinned by the session, never refreshed from the server: a replaced mediator's late requests must stay distinguishable (engine rework E1).
    """
    value = os.environ.get("CONSENSUS_MEDIATOR", "")
    if not value:
        return {}
    match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9._:-]*)@([0-9]+)", value)
    if not match:
        raise ValueError("CONSENSUS_MEDIATOR must be <participant>@<version>")
    return {"x-consensus-mediator": match.group(1), "x-consensus-mediator-version": match.group(2)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--launch-file", type=Path, default=Path.home() / "Library/Application Support/ConsensusRoom/consensus-room.url")
    parser.add_argument("command", choices=["due", "claim", "snapshot", "unchanged", "failure", "attach", "status", "batch", "ack", "connections", "use-rest", "metrics", "host-import", "host-plan", "catalog", "collect"])
    parser.add_argument("--id", help="source ID, or topic ID for attach/status")
    parser.add_argument("--input", type=Path, help="JSON file (do not place secret credentials here)")
    parser.add_argument("--session", help="실제 중재자 세션 ID; batch/ack에 필수")
    parser.add_argument("--batch", help="읽기를 마친 batchId; ack에 필수")
    parser.add_argument("--page-bytes", type=int, help="batch 한 쪽의 최대 바이트(1~240000). 이 출력 전체(끝 개행 제외)가 이 크기 이하다")
    parser.add_argument("--offset", type=int, default=0, help="host-plan metadata page offset")
    parser.add_argument("--limit", type=int, default=50, help="host-plan metadata page size (1~50)")
    args = parser.parse_args()
    identity = mediator_identity()
    if args.offset < 0 or not 1 <= args.limit <= 50:
        parser.error("host-plan offset must be nonnegative and limit must be 1~50")
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
        "host-import": f"/api/topics/{source_id}/evidence/host-import",
        "catalog": f"/api/topics/{source_id}/evidence/catalog",
        "host-plan": f"/api/topics/{source_id}/evidence/host-plan?offset={args.offset}&limit={args.limit}",
        "collect": f"/api/topics/{source_id}/evidence/collect",
    }[args.command]
    data = None
    if args.command not in {"due", "status", "connections", "metrics", "catalog", "host-plan"}:
        if args.command in {"claim", "use-rest", "collect"}:
            data = b"{}"
        elif args.command in {"batch", "ack"}:
            if not args.session or (args.command == "ack" and not args.batch):
                parser.error("batch/ack에는 --session, ack에는 --batch가 필요합니다")
            if args.page_bytes is not None and args.command != "batch":
                parser.error("--page-bytes는 batch에만 쓸 수 있습니다")
            body = {"sessionId": args.session}
            if args.command == "ack":
                body["batchId"] = args.batch
            elif args.page_bytes is not None:
                body["pageBytes"] = args.page_bytes
            data = json.dumps(body).encode()
        else:
            if not args.input:
                parser.error("--input is required")
            if args.input.stat().st_size > 16_000_000:
                parser.error("input exceeds the source limit")
            data = json.dumps(json.loads(args.input.read_text()), ensure_ascii=False).encode()
    request = Request(base + route, data=data, method="GET" if data is None else "POST", headers={
        "x-consensus-token": token, "x-consensus-actor": "mediator", "content-type": "application/json", **identity,
    })
    try:
        with build_opener(NoRedirect).open(request, timeout=200) as response:
            body = response.read()
    except HTTPError as error:
        # Server errors can contain operator data; return only code, no request headers/URL token.
        raise ValueError(f"Consensus Room returned HTTP {error.code}") from None
    json.loads(body)
    # Only an explicit batch request returns changed source text. No command acknowledges it automatically.
    # 서버 응답 본문 바이트를 그대로 쓴다(끝 개행 1바이트만 더한다) — 서버가 잰 쪽 크기가 곧 이 출력의 크기다. 다시 직렬화하지 않는다.
    sys.stdout.buffer.write(body + b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
