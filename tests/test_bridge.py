import json
import socket
import threading
import time
import unittest
import urllib.request
import urllib.error
from protocol import Receiver, parse_command
from server import Bridge, make_server


class ProtocolTests(unittest.TestCase):
    def test_invalid_values_and_version(self):
        for packet in [b'G3,1,abcdef12,1,1,nan,0', b'G3,1,abcdef12,1,1,0,inf', b'G3,2,abcdef12,1,1,0,0', b'G3,1,abcdef12,1,1,1,0', b'G3,1,abcdef12,1,0,.1,0']:
            self.assertIsNone(parse_command(packet))

    def test_handshake_sequence_timeout_and_new_session(self):
        now = [0.0]
        receiver = Receiver(clock=lambda: now[0])
        self.assertIsNone(receiver.receive(b'G3,1,abcdef12,1,1,.2,0'))
        self.assertIsNotNone(receiver.receive(b'G3,1,abcdef12,1,0,0,0'))
        self.assertIsNotNone(receiver.receive(b'G3,1,abcdef12,2,1,.2,.1'))
        self.assertEqual(receiver.speed, .2)
        self.assertIsNone(receiver.receive(b'G3,1,abcdef12,1,1,.6,0'))
        now[0] = .36
        receiver.tick()
        self.assertEqual(receiver.speed, 0)
        self.assertIsNone(receiver.receive(b'G3,1,abcdef12,3,1,.2,0'))
        self.assertIsNotNone(receiver.receive(b'G3,1,12345678,1,0,0,0'))
        self.assertIsNotNone(receiver.receive(b'G3,1,12345678,2,1,.2,0'))


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.socket.bind(('127.0.0.1', 0)); self.socket.settimeout(.03)
        self.receiver = Receiver(); self.done = threading.Event(); self.packets = []
        self.acknowledge = True
        def loop():
            while not self.done.is_set():
                try:
                    data, peer = self.socket.recvfrom(256)
                    self.packets.append(data)
                    ack = self.receiver.receive(data)
                    if ack and self.acknowledge: self.socket.sendto(ack, peer)
                except socket.timeout: pass
                self.receiver.tick()
        self.thread = threading.Thread(target=loop); self.thread.start()
        self.bridge = Bridge(self.socket.getsockname())

    def tearDown(self):
        self.bridge.close(); self.done.set(); self.thread.join(); self.socket.close()

    def send_for(self, token, duration):
        deadline = time.monotonic() + duration; seq = 0
        while time.monotonic() < deadline:
            seq += 1
            self.bridge.command({'token': token, 'seq': seq, 'speed': .2, 'turn': -.1})
            time.sleep(.04)

    def test_udp_roundtrip_and_browser_watchdog(self):
        token = self.bridge.arm('demo')['token']
        self.send_for(token, .25)
        self.assertEqual(self.receiver.speed, .2)
        self.assertEqual(self.bridge.status()['receiver_mode'], 'SIM')
        time.sleep(.45)
        self.assertFalse(self.bridge.status()['active'])
        self.assertEqual(self.receiver.speed, 0)
        with self.assertRaises(ValueError):
            self.bridge.command({'token': token, 'seq': 50, 'speed': .2, 'turn': 0})

    def test_no_nonzero_output_before_ack_and_ack_timeout(self):
        self.acknowledge = False
        token = self.bridge.arm('demo')['token']
        try: self.send_for(token, .7)
        except ValueError: pass
        self.assertFalse(self.bridge.status()['active'])
        self.assertTrue(all(parse_command(p)[3] == 0 for p in self.packets))

    def test_invalid_command_disarms_and_replay_does_not_refresh(self):
        token = self.bridge.arm('live')['token']
        self.bridge.command({'token': token, 'seq': 1, 'speed': .2, 'turn': 0})
        with self.assertRaises(ValueError): self.bridge.command({'token': token, 'seq': 1, 'speed': .2, 'turn': 0})
        with self.assertRaises(ValueError): self.bridge.command({'token': token, 'seq': 2, 'speed': float('nan'), 'turn': 0})
        self.assertFalse(self.bridge.status()['active'])

    def test_http_static_and_command_api(self):
        server, _ = make_server(0, self.bridge)
        thread = threading.Thread(target=server.serve_forever); thread.start()
        root = f'http://127.0.0.1:{server.server_port}'
        def post(path, data):
            request = urllib.request.Request(root + path, json.dumps(data).encode(), {'Content-Type': 'application/json', 'Origin': root})
            with urllib.request.urlopen(request) as response: return json.load(response)
        try:
            for asset in ('/', '/app.js', '/analysis.js', '/feature-worklet.js', '/style.css'):
                with urllib.request.urlopen(root + asset) as r: self.assertEqual(r.status, 200)
            armed = post('/api/arm', {'source': 'demo'})
            self.assertTrue(post('/api/command', {'token': armed['token'], 'seq': 1, 'speed': .1, 'turn': 0})['active'])
            self.assertFalse(post('/api/stop', {'token': armed['token']})['active'])
            for path in ('/server.py', '/firmware/g3_receiver/config.h'):
                with self.assertRaises(urllib.error.HTTPError) as cm: urllib.request.urlopen(root + path)
                self.assertEqual(cm.exception.code, 404)
            request = urllib.request.Request(root + '/api/arm', b'{"source":"demo"}', {'Content-Type': 'application/json', 'Origin': 'https://example.com'})
            with self.assertRaises(urllib.error.HTTPError) as cm: urllib.request.urlopen(request)
            self.assertEqual(cm.exception.code, 403)
        finally:
            server.shutdown(); thread.join(); server.server_close()

    def test_demo_is_refused_for_nonloopback_target(self):
        original = self.bridge.loopback
        self.bridge.loopback = False
        try:
            with self.assertRaises(ValueError): self.bridge.arm('demo')
        finally: self.bridge.loopback = original


if __name__ == '__main__':
    unittest.main()
