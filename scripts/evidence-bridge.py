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
    parser.add_argument("command", choices=["due", "claim", "snapshot", "unchanged", "failure", "attach", "status"])
    parser.add_argument("--id", help="source ID, or topic ID for attach/status")
    parser.add_argument("--input", type=Path, help="JSON file (do not place secret credentials here)")
    args = parser.parse_args()
    base, token = connection(args.launch_file)
    if args.command != "due" and not args.id:
        parser.error("--id is required")
    source_id = quote(args.id or "", safe="")
    route = {
        "due": "/api/evidence/due", "claim": f"/api/evidence/{source_id}/check",
        "snapshot": f"/api/evidence/{source_id}/snapshot", "unchanged": f"/api/evidence/{source_id}/unchanged",
        "failure": f"/api/evidence/{source_id}/failure", "attach": f"/api/topics/{source_id}/evidence/sources",
        "status": f"/api/topics/{source_id}/evidence",
    }[args.command]
    data = None
    if args.command not in {"due", "status"}:
        if args.command == "claim":
            data = b"{}"
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
        with build_opener(NoRedirect).open(request, timeout=100) as response:
            result = json.load(response)
    except HTTPError as error:
        # Server errors can contain operator data; return only code, no request headers/URL token.
        raise ValueError(f"Consensus Room returned HTTP {error.code}") from None
    # Ingestion endpoints return metadata, never the original document or design image.
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
