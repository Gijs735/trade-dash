import json
import logging
import os
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import azure.functions as func
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings


app = func.FunctionApp()

NASDAQ_DIVIDEND_URL = "https://api.nasdaq.com/api/quote/STRC/dividends?assetclass=stocks"
STORAGE_ACCOUNT_NAME = os.getenv("STRC_DIVIDEND_STORAGE_ACCOUNT", "msmstorai")
STATIC_SITE_CONTAINER = os.getenv("STRC_DIVIDEND_STORAGE_CONTAINER", "$web")
OUTPUT_BLOB_NAME = "strc-dividends.json"
SYMBOL = "STRC"


@app.timer_trigger(schedule="0 0 6 * * *", arg_name="timer", run_on_startup=False, use_monitor=True)
def fetch_strc_dividends(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("STRC dividend fetch timer is past due.")

    refresh_strc_dividend_blob()


@app.route(route="refresh-strc-dividends", methods=["GET", "POST"], auth_level=func.AuthLevel.FUNCTION)
def refresh_strc_dividends(req: func.HttpRequest) -> func.HttpResponse:
    try:
        result = refresh_strc_dividend_blob()
        return func.HttpResponse(
            json.dumps(result, indent=2, sort_keys=True),
            status_code=200,
            mimetype="application/json",
        )
    except Exception as err:
        logging.exception("Manual STRC dividend refresh failed.")
        return func.HttpResponse(
            json.dumps({
                "ok": False,
                "error": str(err),
                "blob": f"{STATIC_SITE_CONTAINER}/{OUTPUT_BLOB_NAME}",
            }, indent=2, sort_keys=True),
            status_code=500,
            mimetype="application/json",
        )


def refresh_strc_dividend_blob() -> dict:
    payload = build_dividend_payload()
    upload_payload(payload)
    logging.info(
        "Wrote %s STRC dividend rows to %s/%s.",
        len(payload["dividends"]),
        STATIC_SITE_CONTAINER,
        OUTPUT_BLOB_NAME,
    )

    return {
        "ok": True,
        "symbol": SYMBOL,
        "rows": len(payload["dividends"]),
        "fetchedAt": payload["fetchedAt"],
        "blob": f"{STATIC_SITE_CONTAINER}/{OUTPUT_BLOB_NAME}",
    }


def build_dividend_payload() -> dict:
    rows = fetch_nasdaq_dividend_rows()
    dividends = [parse_dividend_row(row) for row in rows]
    dividends = [dividend for dividend in dividends if dividend is not None]

    return {
        "source": "nasdaq",
        "sourceUrl": NASDAQ_DIVIDEND_URL,
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "symbol": SYMBOL,
        "dividends": dividends,
    }


def fetch_nasdaq_dividend_rows() -> list[dict]:
    request = Request(
        NASDAQ_DIVIDEND_URL,
        headers={
            "Accept": "application/json, text/plain, */*",
            "User-Agent": (
                "Mozilla/5.0 (compatible; trade-dash dividend fetcher; "
                "+https://btc.finestbit.com)"
            ),
        },
    )

    try:
        with urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8")
    except HTTPError as err:
        raise RuntimeError(f"Nasdaq dividend request failed with HTTP {err.code}") from err
    except URLError as err:
        raise RuntimeError(f"Nasdaq dividend request failed: {err.reason}") from err

    data = json.loads(body)
    rows = data.get("data", {}).get("dividends", {}).get("rows")
    if not isinstance(rows, list):
        raise RuntimeError("Nasdaq dividend response did not include dividend rows")

    return rows


def parse_dividend_row(row: dict) -> dict | None:
    ex_dividend_date = parse_us_date(row.get("exOrEffDate"))
    payment_date = parse_us_date(row.get("paymentDate"))
    record_date = parse_us_date(row.get("recordDate"))
    declaration_date = parse_us_date(row.get("declarationDate"))
    amount_usd = parse_usd_amount(row.get("amount"))

    if ex_dividend_date is None or payment_date is None or amount_usd is None:
        logging.warning("Skipping unusable dividend row: %s", row)
        return None

    return {
        "exDividendDate": ex_dividend_date,
        "amountUsd": float(amount_usd),
        "recordDate": record_date,
        "declarationDate": declaration_date,
        "paymentDate": payment_date,
        "type": row.get("type") or "Cash",
        "currency": row.get("currency") or "USD",
    }


def parse_us_date(value: str | None) -> str | None:
    if not value or value == "N/A":
        return None

    return datetime.strptime(value, "%m/%d/%Y").date().isoformat()


def parse_usd_amount(value: str | None) -> Decimal | None:
    if not value or value == "N/A":
        return None

    try:
        return Decimal(value.replace("$", "").replace(",", "").strip())
    except InvalidOperation:
        return None


def upload_payload(payload: dict) -> None:
    connection_string = os.getenv("STRC_DIVIDEND_STORAGE_CONNECTION_STRING")
    if connection_string:
        blob_service = BlobServiceClient.from_connection_string(connection_string)
    else:
        account_url = f"https://{STORAGE_ACCOUNT_NAME}.blob.core.windows.net"
        credential = DefaultAzureCredential()
        blob_service = BlobServiceClient(account_url=account_url, credential=credential)

    blob_client = blob_service.get_blob_client(
        container=STATIC_SITE_CONTAINER,
        blob=OUTPUT_BLOB_NAME,
    )
    body = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")

    blob_client.upload_blob(
        body,
        overwrite=True,
        content_settings=ContentSettings(
            content_type="application/json; charset=utf-8",
            cache_control="public, max-age=300",
            content_language="en",
        ),
    )
