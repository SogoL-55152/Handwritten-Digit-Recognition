"""Bounded operator maintenance; preview by default, never runs during app startup."""
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
import subprocess


def statements(database, days, batch, now=None):
    if not re.fullmatch(r'hdr_pilot_[A-Za-z0-9_]+', database):
        raise ValueError('Only explicitly named hdr_pilot_* databases are supported')
    if not 7 <= days <= 365 or not 1 <= batch <= 1000:
        raise ValueError('Retention must be 7-365 days; batch must be 1-1000')
    now = now or datetime.now(timezone.utc)
    stamp = (now - timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
    session_stamp = (now - timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S')
    targets = [
        ('t_recognition_v2', f"created_at < '{stamp}' AND status IN ('SUCCEEDED','FAILED')"),
        ('t_auth_session', f"expires_at < '{session_stamp}'"),
    ]
    preview = '\n'.join(f'SELECT COUNT(*) FROM {table} WHERE {where};' for table, where in targets)
    deletes = '\n'.join(f'DELETE FROM {table} WHERE {where} LIMIT {batch}; SELECT ROW_COUNT();' for table, where in targets)
    return preview, deletes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mysql', required=True, help='Absolute path to trusted mysql client')
    parser.add_argument('--defaults-file', required=True, help='Private MySQL client option file; contents are never read or printed')
    parser.add_argument('--database', required=True)
    parser.add_argument('--days', type=int, default=30)
    parser.add_argument('--batch', type=int, default=500)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm-database')
    parser.add_argument('--backup-verified', action='store_true')
    args = parser.parse_args(argv)
    preview, deletes = statements(args.database, args.days, args.batch)
    mysql, defaults = Path(args.mysql), Path(args.defaults_file)
    if not mysql.is_absolute() or not mysql.is_file() or not defaults.is_absolute() or not defaults.is_file():
        parser.error('Explicit existing absolute client and option-file paths required')
    if args.apply and (args.confirm_database != args.database or not args.backup_verified):
        parser.error('Apply requires matching --confirm-database and --backup-verified')
    command = [str(mysql), '--defaults-file=' + str(defaults), '--batch', '--skip-column-names', '--database=' + args.database]
    def execute(sql):
        result = subprocess.run(command, input="SET time_zone='+00:00';\n" + sql, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError('Database maintenance failed; connection/SQL details suppressed')
        return result.stdout.strip()
    if execute('SELECT DATABASE();') != args.database:
        raise RuntimeError('Connected database mismatch')
    print('Eligible records / expired sessions:', execute(preview).splitlines())
    if args.apply:
        print('Deleted this batch (records / sessions):', execute(deletes).splitlines())
    else:
        print('PREVIEW ONLY. Verify backup and counts before explicit apply; no rows deleted.')
    print('Active/processing requests, user accounts, files, logs and backups are untouched.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        raise SystemExit(str(error))
