"""Guitar Motion Lab v1: newline-delimited, normalized UDP commands."""
import math
import re
import time

WATCHDOG_SECONDS = 0.35
SESSION_RE = re.compile(r"^[0-9a-f]{8}$")


def parse_command(packet):
    try:
        text = packet.decode("ascii").strip()
        fields = text.split(",")
        if len(fields) != 7 or fields[:2] != ["G3", "1"]:
            return None
        _, _, session, seq_text, enabled, speed_text, turn_text = fields
        if not SESSION_RE.fullmatch(session) or not seq_text.isdigit() or enabled not in ("0", "1"):
            return None
        seq, speed, turn = int(seq_text), float(speed_text), float(turn_text)
        if not (0 <= seq < 2**32 and math.isfinite(speed) and math.isfinite(turn)):
            return None
        if not (0 <= speed <= .6 and -.6 <= turn <= .6):
            return None
        if enabled == "0" and (speed != 0 or turn != 0):
            return None
        return session, seq, enabled == "1", speed, turn
    except (UnicodeDecodeError, ValueError):
        return None


class Receiver:
    """Reference receiver, used by the PC simulator and protocol tests."""
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.session = None
        self.seq = -1
        self.last_seen = -math.inf
        self.speed = self.turn = 0.0
        self.expired = True

    def receive(self, packet):
        parsed = parse_command(packet)
        if parsed is None:
            return None
        session, seq, enabled, speed, turn = parsed
        self.tick()
        if session != self.session:
            if enabled:
                return None  # A zero-command handshake must establish each session.
            self.session, self.seq, self.expired = session, -1, False
        if seq <= self.seq or (enabled and self.expired):
            return None
        self.seq = seq
        self.last_seen = self.clock()
        self.speed, self.turn = (speed, turn) if enabled else (0, 0)
        # A stopped/expired session cannot resume from delayed enabled packets.
        # A different zero-command session is required after a watchdog timeout.
        return f"G3ACK,1,{session},{seq},SIM\n".encode("ascii")

    def tick(self):
        if self.clock() - self.last_seen > WATCHDOG_SECONDS:
            self.speed = self.turn = 0.0
            self.expired = True
