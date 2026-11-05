"""PC-only UDP receiver. No motor or GPIO access."""
import argparse
import socket
import time
from protocol import Receiver


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=9000)
    args = parser.parse_args()
    receiver = Receiver()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", args.port))
        sock.settimeout(.05)
        print(f"PC内UDP受信テスト: 127.0.0.1:{args.port} / モーターは動作しません。", flush=True)
        last_print = 0
        try:
            while True:
                try:
                    packet, address = sock.recvfrom(256)
                    ack = receiver.receive(packet)
                    if ack:
                        sock.sendto(ack, address)
                except socket.timeout:
                    pass
                receiver.tick()
                if time.monotonic() - last_print > .5:
                    print(f"speed={receiver.speed:+.3f} turn={receiver.turn:+.3f} watchdog={'STOP' if receiver.expired else 'OK'}", flush=True)
                    last_print = time.monotonic()
        except KeyboardInterrupt:
            print("受信テスト終了")


if __name__ == "__main__":
    main()
