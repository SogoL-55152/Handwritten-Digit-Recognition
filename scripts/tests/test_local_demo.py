import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('local_demo', Path(__file__).resolve().parents[1] / 'local-demo.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LocalDemoTests(unittest.TestCase):
    def args(self, **extra):
        defaults = dict(service='backend', env_file=None, allow_development_registration=False,
                        java=None, python=None, node=None, mysqld=None, mysql_data=None)
        defaults.update(extra)
        return SimpleNamespace(**defaults)

    def test_default_preserves_pilot_and_only_explicit_flag_opens_local_admission(self):
        with patch.dict(module.os.environ, {}, clear=True):
            default = module.environment(self.args())
            development = module.environment(self.args(allow_development_registration=True))
        self.assertEqual(default['HDR_PILOT_ENABLED'], 'true')
        self.assertEqual(default['SPRING_PROFILES_ACTIVE'], 'pilot')
        self.assertEqual(development['HDR_PILOT_ENABLED'], 'false')
        self.assertEqual(development['SERVER_ADDRESS'], '127.0.0.1')
        self.assertEqual(development['HOST'], '127.0.0.1')
        self.assertEqual(development['VITE_APP_MODE'], 'development')

    def test_private_config_only_reads_documented_scalar_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'fixture.json'
            file.write_text('{"DB_PASSWORD":"synthetic-password","UNRELATED":"ignored"}')
            self.assertEqual(module.private_environment(file), {'DB_PASSWORD': 'synthetic-password'})
            file.write_text('{"DB_PASSWORD":false}')
            with self.assertRaises(ValueError): module.private_environment(file)
            file.write_text('[]')
            with self.assertRaises(ValueError): module.private_environment(file)

    def test_missing_config_does_not_create_files(self):
        with tempfile.TemporaryDirectory() as temp:
            missing = Path(temp) / 'absent.json'
            with self.assertRaises(ValueError): module.private_environment(missing)
            self.assertFalse(missing.exists())

    def test_remote_database_is_refused(self):
        with patch.object(module, 'listening', return_value=True):
            with self.assertRaises(ValueError):
                module.command(self.args(), {'DB_URL': 'jdbc:mysql://remote.invalid:13316/hdr'})

    def test_mysql_never_initializes_or_reuses_an_empty_data_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp) / 'data'
            data.mkdir()
            with patch.object(module, 'executable', return_value=str(Path(temp) / 'bin/mysqld.exe')):
                with self.assertRaises(ValueError): module.command(self.args(service='mysql', mysql_data=str(data)), {})
                (data / 'auto.cnf').write_text('[auto]\n')
                command = module.command(self.args(service='mysql', mysql_data=str(data)), {})
                self.assertIn('--bind-address=127.0.0.1', command)
                self.assertIn('--port=13316', command)
                self.assertNotIn('--initialize', ' '.join(command))

    def test_occupied_port_never_launches_or_stops_any_process(self):
        with patch.object(module, 'listening', return_value=True), patch.object(module.subprocess, 'Popen') as spawn:
            with self.assertRaises(ValueError): module.main(['web'])
            spawn.assert_not_called()


if __name__ == '__main__': unittest.main()
