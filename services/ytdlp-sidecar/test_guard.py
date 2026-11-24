"""The sidecar's address check, with no network: run with `python3 -m unittest test_guard` in this folder."""

import ipaddress
import unittest

from guard import Refused, check_url, is_public

PUBLIC = lambda host, port: ["93.184.216.34"]  # noqa: E731


class AddressCheck(unittest.TestCase):
    def test_this_machine_and_private_networks_are_refused_in_every_spelling(self):
        for url in [
            "http://127.0.0.1/", "http://127.1/", "http://0x7f.1/", "http://2130706433/", "http://0177.0.0.1/", "http://0.0.0.0/",
            "http://10.0.0.1/", "http://100.64.0.1/", "http://169.254.169.254/latest/meta-data/", "http://224.0.0.1/", "http://192.0.2.1/",
            "http://[::1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://[::7f00:1]/", "http://[64:ff9b::7f00:1]/",
            "http://[64:ff9b:1::7f00:1]/", "http://[2002:7f00:1::]/", "http://[::ffff:a9fe:a9fe]/", "http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/",
            "http://[fe80::1]/", "http://[fc00::1]/", "http://[fd00:ec2::254]/", "http://localhost:8080/", "http://api.localhost/",
            "file:///etc/passwd", "https://user:pw@example.org/", "http://example.org\\@127.0.0.1/",
        ]:
            with self.subTest(url=url), self.assertRaises(Refused):
                check_url(url)

    def test_a_name_is_resolved_and_every_address_checked(self):
        check_url("https://example.org/watch", resolve=PUBLIC)
        with self.assertRaises(Refused):
            check_url("https://rebind.example/", resolve=lambda h, p: ["93.184.216.34", "::ffff:127.0.0.1"])
        with self.assertRaises(Refused):
            check_url("https://nowhere.example/", resolve=lambda h, p: [])

        def down(host, port):
            raise OSError("no dns")

        with self.assertRaises(Refused):
            check_url("https://down.example/", resolve=down)

    def test_public_addresses_and_the_forms_that_reach_them_pass(self):
        for text in ["93.184.216.34", "::ffff:93.184.216.34", "64:ff9b::5db8:d822", "2606:4700::1111"]:
            self.assertTrue(is_public(ipaddress.ip_address(text)), text)
        for text in ["2002:5db8:d822::", "::5db8:d822", "64:ff9b:1::5db8:d822", "2001:db8::1"]:
            self.assertFalse(is_public(ipaddress.ip_address(text)), text)


if __name__ == "__main__":
    unittest.main()
