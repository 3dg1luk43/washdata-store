"""
WashData Store - Python read client for the ha_washdata integration.

Reads approved envelopes from the WashData Store via the Firestore REST API.
No Firebase SDK needed - just requests.

Envelope schema versions:
  1 - fields: avg, min, max, target_duration, avg_energy, duration_std_dev, cycle_count

To use inside a Home Assistant integration (async), wrap calls in
hass.async_add_executor_job(client.list_envelopes, {...})
"""

import json
from typing import Any

import requests

FIRESTORE_BASE = "https://firestore.googleapis.com/v1"
IDENTITY_BASE = "https://identitytoolkit.googleapis.com/v1"
SUPPORTED_ENVELOPE_SCHEMA_VERSIONS = {1}


class StoreClient:
    def __init__(self, project_id: str, api_key: str):
        self._project_id = project_id
        self._api_key = api_key
        self._id_token: str | None = None
        self._session = requests.Session()

    def _sign_in_anonymous(self) -> str:
        """Sign in anonymously for a Firestore idToken."""
        resp = self._session.post(
            f"{IDENTITY_BASE}/accounts:signUp?key={self._api_key}",
            json={"returnSecureToken": True},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()["idToken"]

    def _get_token(self) -> str:
        if not self._id_token:
            self._id_token = self._sign_in_anonymous()
        return self._id_token

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._get_token()}"}

    def _doc_path(self, *parts: str) -> str:
        return f"projects/{self._project_id}/databases/(default)/documents/{'/'.join(parts)}"

    # --- Firestore typed-value decoder ---

    @staticmethod
    def _decode_value(val: dict[str, Any]) -> Any:
        """Decode a Firestore typed value into a plain Python value."""
        if "stringValue" in val:
            return val["stringValue"]
        if "integerValue" in val:
            return int(val["integerValue"])
        if "doubleValue" in val:
            return float(val["doubleValue"])
        if "booleanValue" in val:
            return val["booleanValue"]
        if "nullValue" in val:
            return None
        if "timestampValue" in val:
            return val["timestampValue"]
        if "arrayValue" in val:
            return [StoreClient._decode_value(v) for v in val["arrayValue"].get("values", [])]
        if "mapValue" in val:
            return {
                k: StoreClient._decode_value(v)
                for k, v in val["mapValue"].get("fields", {}).items()
            }
        return None

    @staticmethod
    def _decode_doc(doc: dict[str, Any]) -> dict[str, Any]:
        """Decode a Firestore document into a plain dict."""
        fields = doc.get("fields", {})
        result = {k: StoreClient._decode_value(v) for k, v in fields.items()}
        # Add document ID from name path
        name = doc.get("name", "")
        result["_id"] = name.rsplit("/", 1)[-1] if "/" in name else name
        return result

    # --- Envelope schema versioning ---

    @staticmethod
    def decode_envelope(record: dict[str, Any]) -> dict[str, Any] | None:
        """
        Decode the envelope field from a store record into a plain dict.

        Returns None if the envelopeSchemaVersion is unsupported.
        Adds _envelopeSchemaVersion to the result for caller reference.

        envelopeSchemaVersion 1 (current):
          avg, min, max, target_duration, avg_energy, duration_std_dev, cycle_count
        """
        version = record.get("envelopeSchemaVersion", 1)
        if version not in SUPPORTED_ENVELOPE_SCHEMA_VERSIONS:
            return None
        envelope = record.get("envelope")
        if not isinstance(envelope, dict):
            return None
        result = dict(envelope)
        result["_envelopeSchemaVersion"] = version
        return result

    # --- Public API ---

    def list_envelopes(
        self,
        appliance_type: str | None = None,
        brand: str | None = None,
        page_size: int = 24,
    ) -> list[dict[str, Any]]:
        """
        List approved envelopes, optionally filtered by appliance_type and/or brand.

        brand matching is case-insensitive (matched against brand_lc).
        Returns a list of decoded records; unsupported envelope versions are included
        with envelope=None so callers can skip or warn.
        """
        filters = [
            {"fieldFilter": {
                "field": {"fieldPath": "status"},
                "op": "EQUAL",
                "value": {"stringValue": "approved"},
            }}
        ]
        if appliance_type:
            filters.append({"fieldFilter": {
                "field": {"fieldPath": "applianceType"},
                "op": "EQUAL",
                "value": {"stringValue": appliance_type},
            }})
        if brand:
            filters.append({"fieldFilter": {
                "field": {"fieldPath": "brand_lc"},
                "op": "EQUAL",
                "value": {"stringValue": brand.lower()},
            }})

        composite_filter = (
            {"compositeFilter": {"op": "AND", "filters": filters}}
            if len(filters) > 1
            else filters[0]
        )

        structured_query = {
            "from": [{"collectionId": "envelopes"}],
            "where": composite_filter,
            "orderBy": [{"field": {"fieldPath": "createdAt"}, "direction": "DESCENDING"}],
            "limit": page_size,
        }

        url = f"{FIRESTORE_BASE}/{self._doc_path()}:runQuery"
        resp = self._session.post(
            url, json={"structuredQuery": structured_query},
            headers=self._headers(), timeout=15,
        )
        resp.raise_for_status()

        results = []
        for item in resp.json():
            if "document" not in item:
                continue
            record = self._decode_doc(item["document"])
            record["envelope"] = self.decode_envelope(record)
            results.append(record)
        return results

    def get_envelope(self, doc_id: str) -> dict[str, Any]:
        """Fetch a single envelope by Firestore document ID."""
        url = f"{FIRESTORE_BASE}/{self._doc_path('envelopes', doc_id)}"
        resp = self._session.get(url, headers=self._headers(), timeout=10)
        resp.raise_for_status()
        record = self._decode_doc(resp.json())
        record["envelope"] = self.decode_envelope(record)
        return record

    def close(self) -> None:
        self._session.close()


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="WashData Store CLI reader")
    parser.add_argument("project_id")
    parser.add_argument("api_key")
    parser.add_argument("--type", help="appliance type filter")
    parser.add_argument("--brand", help="brand filter (case-insensitive)")
    parser.add_argument("--get", metavar="DOC_ID", help="fetch a single envelope by ID")
    args = parser.parse_args()

    client = StoreClient(args.project_id, args.api_key)
    try:
        if args.get:
            record = client.get_envelope(args.get)
            print(json.dumps(record, indent=2, default=str))
        else:
            records = client.list_envelopes(args.type, args.brand)
            print(f"Found {len(records)} envelope(s)")
            for r in records:
                env_ver = r.get("envelopeSchemaVersion", "?")
                print(f"  {r['_id']:24s}  {r.get('brand', '')} {r.get('model', '')} - {r.get('program', '')} (envelopeSchemaVersion={env_ver})")
    finally:
        client.close()
