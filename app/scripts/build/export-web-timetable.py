#!/usr/bin/env python3
"""Export a stable, read-only native timetable as a browser lookup snapshot.

Usage: python3 scripts/build/export-web-timetable.py INPUT.sqlite OUTPUT.json
The source is opened read-only, integrity checked and hashed before/after.
No route application is exported: incomplete route/history evidence remains
read-only in the Web editor.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3

TABLES = {
    'services': 'service_id,canonical_name',
    'service_name_periods': 'service_id,name,language,valid_from,valid_until',
    'timetable_versions': 'timetable_version_id,effective_from,effective_until,completeness,edition_name',
    'calendars': 'calendar_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,valid_from,valid_until,holiday_policy',
    'calendar_exceptions': 'calendar_id,service_date,exception_type',
    'holiday_calendar_years': 'year,status',
    'holiday_dates': 'service_date',
    'station_identities': 'station_id,name_snapshot,reference_kind,current_source_code,valid_from,valid_until',
    'trips': 'trip_id,timetable_version_id,service_id,calendar_id,train_number,public_number,service_class',
    'stop_times': 'trip_id,stop_sequence,station_id,arrival_time,departure_time,arrival_seconds,departure_seconds,call_type,platform,source_id',
    'trip_stop_time_overrides': 'trip_id,service_date,stop_sequence,arrival_override,departure_override,arrival_seconds_override,departure_seconds_override,platform_override,platform_override_present,source_id',
    'trip_train_number_overrides': 'trip_id,service_date,train_number,source_id',
    'trip_timetable_symbols': 'trip_id,after_stop_sequence,position,station_name,symbol,source_id',
    'timetable_version_sources': 'timetable_version_id,source_id',
    'source_documents': 'source_id,publisher,title,url_or_locator,license_status,redistribution_status',
}

def export_snapshot(source, output):
    source = source.resolve()
    initial = hashlib.sha256(source.read_bytes()).hexdigest()
    db = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Timetable integrity check failed')
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('Timetable foreign key check failed')
        metadata = dict(db.execute('SELECT key,value FROM metadata'))
        data = {name: [dict(row) for row in db.execute(f'SELECT {columns} FROM {name} ORDER BY {columns.split(",")[0]},rowid')]
                for name, columns in TABLES.items()}
    finally:
        db.close()
    if hashlib.sha256(source.read_bytes()).hexdigest() != initial:
        raise ValueError('Source changed during export; wait for stable owner handoff')
    snapshot = {'format': 'jtm-web-timetable-1', 'source_sha256': initial,
                'source_metadata': metadata, **data}
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')) + '\n'
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + '.tmp')
    temporary.write_text(encoded)
    temporary.replace(output)
    print(f'Exported {len(data["trips"])} templates and {len(data["stop_times"])} calls; source SHA-256 {initial}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    export_snapshot(args.source, args.output)
