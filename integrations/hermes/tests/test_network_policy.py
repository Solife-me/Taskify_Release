import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import network_policy as policy


class NetworkPolicyTests(unittest.TestCase):
    def test_discovery_matches_entire_approved_relay_route(self):
        approved = ["wss://relay.example/inbox"]
        advertised = [
            "wss://other.example/inbox", "wss://relay.example/other",
            "wss://relay.example/inbox?other=1", "ws://relay.example/inbox",
            "wss://relay.example:443/inbox",
        ]
        self.assertEqual(policy.approved_peer_relays(advertised, approved), approved)

    def test_unapproved_origin_is_rejected_before_resolution(self):
        with patch.object(policy, "_public_ips") as resolve:
            with self.assertRaisesRegex(ValueError, "origin"):
                policy.download_https("https://unapproved.example/file",
                                      origins=policy.attachment_origins(()), limit=16, timeout=1)
            resolve.assert_not_called()

    def test_dns_rejects_a_host_with_any_nonpublic_address(self):
        addresses = [
            (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 443)),
        ]
        with patch.object(policy.socket, "getaddrinfo", return_value=addresses):
            with self.assertRaisesRegex(ValueError, "non-public"):
                policy._public_ips("files.example", 443)

    def test_request_stays_at_the_pinned_address_and_rejects_redirect(self):
        with patch.object(policy, "_public_ips", return_value=["93.184.216.34"]), \
             patch.object(policy, "_PinnedHTTPSConnection") as connect:
            connection = connect.return_value
            response = connection.getresponse.return_value.__enter__.return_value
            response.status = 302
            with self.assertRaisesRegex(ValueError, "302"):
                policy.download_https("https://files.example/blob", origins={("files.example", 443)},
                                      limit=16, timeout=1)
            connect.assert_called_once()
            self.assertEqual(connect.call_args.args[:3], ("files.example", 443, "93.184.216.34"))
            connection.request.assert_called_once()
            connection.close.assert_called_once()

    def test_stream_stops_at_the_limit_with_no_content_length(self):
        with patch.object(policy, "_public_ips", return_value=["93.184.216.34"]), \
             patch.object(policy, "_PinnedHTTPSConnection") as connect:
            response = connect.return_value.getresponse.return_value.__enter__.return_value
            response.status = 200
            response.getheader.return_value = None
            response.read1.return_value = b"12345"
            with self.assertRaisesRegex(ValueError, "size limit"):
                policy.download_https("https://files.example/blob", origins={("files.example", 443)},
                                      limit=4, timeout=1)
            response.read1.assert_called_once_with(5)

    def test_socket_connect_uses_numeric_ip_and_tls_uses_hostname(self):
        connection = policy._PinnedHTTPSConnection("files.example", 443, "93.184.216.34", 1)
        tls = MagicMock()
        connection._tls_context = tls
        with patch.object(policy.socket, "create_connection") as dial:
            connection.connect()
            dial.assert_called_once_with(("93.184.216.34", 443), 1)
            tls.wrap_socket.assert_called_once_with(dial.return_value, server_hostname="files.example")


if __name__ == "__main__":
    unittest.main()
