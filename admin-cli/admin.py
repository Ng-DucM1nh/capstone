#!/usr/bin/env python3
"""Admin CLI for Livestock Dashboard."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))
sys.path.insert(0, str(PROJECT_ROOT))



def cmd_upload(args):
    """Upload a CSV. The server then refreshes the farm's forecasts as part of the same request."""
    import requests

    with open(args.file, "rb") as f:
        r = requests.post(
            f"{args.api}/api/admin/farms/{args.farm}/upload",
            headers={"Authorization": f"Bearer {args.token}"},
            files={"file": f},
            data={"duplicate_mode": args.mode, "forecast": "false" if args.skip_forecast else "true"},
        )
    body = _print_response(r)
    if not r.ok:
        sys.exit(f"Upload failed (HTTP {r.status_code}); forecasts were not refreshed.")
    forecasts = body.get("forecasts", {})
    if forecasts.get("status") == "skipped":
        print(f"Forecasts not refreshed (--skip-forecast). Later run: {_forecast_command(args)}")
    elif forecasts.get("status") == "updated":
        _print_forecasts(args.farm, forecasts)
    else:
        sys.exit("Upload succeeded. " + forecasts.get(
            "detail", f"The server did not report refreshing forecasts. Run: {_forecast_command(args)}"
        ))


def cmd_forecast(args):
    """Ask the server to recompute a farm's forecasts: to retry, or after deploying a new model."""
    import requests

    r = requests.post(
        f"{args.api}/api/admin/farms/{args.farm}/forecasts/refresh",
        headers={"Authorization": f"Bearer {args.token}"},
    )
    body = _print_response(r)
    if not r.ok:
        sys.exit(f"Refreshing forecasts failed (HTTP {r.status_code}).")
    _print_forecasts(args.farm, body)


def _print_response(r) -> dict:
    try:
        body = r.json()
    except ValueError:
        print(r.text)
        return {}
    print(body)
    return body if isinstance(body, dict) else {}


def _print_forecasts(farm: str, result: dict) -> None:
    print(f"Forecasts refreshed for farm {farm}: {result['animals']} animals, data through "
          f"{result['data_through']}, model {result['model_version']} ({result['seconds']}s).")


def _forecast_command(args) -> str:
    return f"python admin-cli/admin.py forecast --farm {args.farm} --api {args.api} --token <admin JWT>"


def cmd_seed(args):
    from scripts.seed import main
    main()


def cmd_logos(args):
    from scripts.manage_logos import main as logos_main
    sys.argv = [sys.argv[0]] + args.logo_args
    logos_main()


def main():
    parser = argparse.ArgumentParser(description="Livestock Dashboard Admin CLI")
    sub = parser.add_subparsers(dest="command")

    upload = sub.add_parser("upload", help="Upload CSV for a farm, then refresh its weight forecasts")
    upload.add_argument("--farm", required=True)
    upload.add_argument("--file", required=True)
    upload.add_argument("--mode", default="skip", choices=["skip", "overwrite"])
    upload.add_argument("--api", default="http://localhost:8000")
    upload.add_argument("--token", required=True)
    upload.add_argument(
        "--skip-forecast",
        action="store_true",
        help="only upload; refresh the forecasts later with the forecast command",
    )

    forecast = sub.add_parser("forecast", help="Ask the server to refresh a farm's weight forecasts")
    forecast.add_argument("--farm", required=True)
    forecast.add_argument("--api", default="http://localhost:8000")
    forecast.add_argument("--token", required=True)

    sub.add_parser("seed", help="Seed database with users and KF sample data")

    logos = sub.add_parser("logos", help="Manage and audit farm logos")
    logos.add_argument("logo_args", nargs=argparse.REMAINDER, help="Arguments passed to manage_logos.py")

    args = parser.parse_args()
    if args.command == "upload":
        cmd_upload(args)
    elif args.command == "forecast":
        cmd_forecast(args)
    elif args.command == "seed":
        cmd_seed(args)
    elif args.command == "logos":
        cmd_logos(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

