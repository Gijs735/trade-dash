import json
import logging
import os
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import azure.functions as func
import requests
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings


app = func.FunctionApp()

NASDAQ_DIVIDEND_URL = "https://api.nasdaq.com/api/quote/STRC/dividends?assetclass=stocks"
STORAGE_ACCOUNT_NAME = os.getenv("STRC_DIVIDEND_STORAGE_ACCOUNT", "msmstorai")
STATIC_SITE_CONTAINER = os.getenv("STRC_DIVIDEND_STORAGE_CONTAINER", "$web")
OUTPUT_BLOB_NAME = "strc-dividends.json"
SYMBOL = "STRC"
NASDAQ_TIMEOUT_SECONDS = int(os.getenv("STRC_NASDAQ_TIMEOUT_SECONDS", "45"))
NASDAQ_MAX_ATTEMPTS = int(os.getenv("STRC_NASDAQ_MAX_ATTEMPTS", "3"))


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
    last_error: Exception | None = None
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Origin": "https://www.nasdaq.com",
        "Pragma": "no-cache",
        "Referer": "https://www.nasdaq.com/market-activity/stocks/strc/dividend-history",
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
    }

    for attempt in range(1, NASDAQ_MAX_ATTEMPTS + 1):
        try:
            response = requests.get(
                NASDAQ_DIVIDEND_URL,
                headers=headers,
                timeout=NASDAQ_TIMEOUT_SECONDS,
            )
            if 400 <= response.status_code < 500:
                raise RuntimeError(
                    f"Nasdaq dividend request failed with HTTP {response.status_code}"
                )
            response.raise_for_status()
            data = response.json()
            break
        except (requests.RequestException, ValueError, RuntimeError) as err:
            last_error = err

        logging.warning(
            "Nasdaq dividend request attempt %s/%s failed: %s",
            attempt,
            NASDAQ_MAX_ATTEMPTS,
            last_error,
        )
        if attempt < NASDAQ_MAX_ATTEMPTS:
            time.sleep(attempt * 2)
    else:
        raise RuntimeError(
            "Nasdaq dividend request failed after "
            f"{NASDAQ_MAX_ATTEMPTS} attempts; last error: {last_error}"
        ) from last_error

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
