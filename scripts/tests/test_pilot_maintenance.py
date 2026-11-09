import importlib.util
from pathlib import Path
from datetime import datetime, timezone
import unittest

path = Path(__file__).resolve().parents[1] / 'pilot-maintenance.py'
spec = importlib.util.spec_from_file_location('pilot_maintenance', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MaintenanceTests(unittest.TestCase):
    def test_bounded_queries_use_fixed_cutoff_and_do_not_delete_active_work(self):
        preview, delete = module.statements('hdr_pilot_test', 30, 500, datetime(2026, 11, 4, tzinfo=timezone.utc))
        self.assertNotIn('DELETE', preview)
        self.assertIn('2026-10-05 00:00:00', preview)
        self.assertIn("status IN ('SUCCEEDED','FAILED')", delete)
        self.assertEqual(delete.count('LIMIT 500'), 2)
        self.assertNotIn('t_user', delete)
        self.assertNotIn('PROCESSING', delete)

    def test_refuses_existing_w2_unknown_names_and_unbounded_parameters(self):
        for name in ('hdr_w2', 'hdr', 'hdr_pilot_a;DROP DATABASE x', '../hdr_pilot_a'):
            with self.assertRaises(ValueError): module.statements(name, 30, 500)
        for days, batch in ((0, 500), (366, 500), (30, 0), (30, 1001)):
            with self.assertRaises(ValueError): module.statements('hdr_pilot_test', days, batch)


if __name__ == '__main__': unittest.main()
