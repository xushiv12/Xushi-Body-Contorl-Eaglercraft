"""BunnyAI: MediaPipe webcam body controls for browser Eaglercraft (Windows).

K: arm/disarm controller (global). F9: emergency stop (global).
Q or Esc in camera preview: quit.  Directions are latched; jump is momentary.
"""
from __future__ import annotations

import ctypes
import os
import time
from collections import deque
from pathlib import Path

import cv2
import mediapipe as mp
from pynput import keyboard

MODEL = Path(__file__).resolve().parent / 'models' / 'pose_landmarker_lite.task'
CAMERA_INDEX = int(os.environ.get('BUNNY_CAMERA', '0'))
# Tune these after testing your camera placement.
HOLD_SECONDS = 0.32       # keep gesture stable to change direction
LOST_SECONDS = 0.60       # no person -> release all keys
JUMP_COOLDOWN = 0.75
JUMP_UP_SPEED = 0.85      # torso heights / second
JUMP_RISE = 0.085         # torso heights above the baseline

KEYS = {
    'FORWARD': 'w', 'BACK': 's', 'LEFT': 'a', 'RIGHT': 'd',
}
DRAW_CONNECTIONS = [
    (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),
    (11, 23), (12, 24), (23, 24), (23, 25), (25, 27),
    (24, 26), (26, 28),
]


# Chrome and Edge use Chromium's window class. Avoid typing into unrelated apps.
def browser_in_foreground():
    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return False
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, len(buf))
    return buf.value.startswith('Chrome_WidgetWin_')


class Controls:
    def __init__(self):
        self.kb = keyboard.Controller()
        self.down = set()
        self.armed = False
        self.running = True
        self.mode = 'STOP'
        self.pending = None
        self.pending_since = 0.0
        self.last_seen = time.monotonic()
        self.jump_key_up_at = 0.0
        self.last_jump_at = -100.0
        self.jump_history = deque(maxlen=5)
        self.baseline_y = None
        self.last_sample = None
        self.takeoff_wait = False

    def release(self):
        for key in list(self.down):
            try:
                self.kb.release(key)
            except Exception:
                pass
        self.down.clear()

    def stop(self, disarm=True):
        self.release()
        self.mode = 'STOP'
        self.pending = None
        self.baseline_y = None
        self.last_sample = None
        self.takeoff_wait = False
        if disarm:
            self.armed = False

    def change_direction(self, direction):
        if direction == self.mode:
            return
        self.release()
        self.mode = direction
        key = KEYS.get(direction)
        if key:
            self.kb.press(key)
            self.down.add(key)
        print('Direction:', direction)

    def update_candidate(self, candidate, now):
        # NO GESTURE means keep last direction, per the user's request.
        if candidate is None:
            self.pending = None
            return
        if candidate != self.pending:
            self.pending, self.pending_since = candidate, now
        elif now - self.pending_since >= HOLD_SECONDS:
            self.change_direction(candidate)

    def pulse_jump(self, now):
        if now - self.last_jump_at < JUMP_COOLDOWN:
            return
        self.kb.press(keyboard.Key.space)
        self.down.add(keyboard.Key.space)
        self.jump_key_up_at = now + 0.12
        self.last_jump_at = now
        print('JUMP')

    def tick(self, now):
        if keyboard.Key.space in self.down and now >= self.jump_key_up_at:
            self.kb.release(keyboard.Key.space)
            self.down.remove(keyboard.Key.space)
        if self.armed and not browser_in_foreground():
            self.stop(disarm=True)
            print('Paused: browser is not focused. Click Eaglercraft and press K again.')
        if self.armed and now - self.last_seen > LOST_SECONDS:
            self.stop(disarm=True)
            print('Paused: body tracking lost. Press K to resume.')


controls = Controls()


k_held = False

def on_release(key):
    global k_held
    if getattr(key, "char", None) in ("k", "K"):
        k_held = False

def on_press(key):
    global k_held
    if key == keyboard.Key.f9:
        controls.stop(disarm=True)
        print('EMERGENCY STOP (F9)')
    elif getattr(key, 'char', None) in ('k', 'K'):
        if k_held:
            return
        k_held = True
        if controls.armed:
            controls.stop(disarm=True)
            print('Controller paused')
        elif browser_in_foreground():
            controls.stop(disarm=False)
            controls.last_seen = time.monotonic()
            controls.armed = True
            print('Controller ARMED: Eaglercraft should have keyboard focus')
        else:
            print('Open/click Eaglercraft in Chrome or Edge, then press K')


def visible(p):
    return getattr(p, 'visibility', 1.0) >= 0.55


def classify(p, world):
    """Returns direction or None. Front-facing viewer, mirror camera preview."""
    indices = (11, 12, 13, 14, 15, 16)
    if any(not visible(p[i]) for i in indices):
        return None
    ls, rs, le, re, lw, rw = [p[i] for i in indices]
    shoulders_width = max(abs(ls.x - rs.x), 0.12)
    torso_y = (p[23].y + p[24].y) / 2 - (ls.y + rs.y) / 2
    torso_h = max(torso_y, 0.12)

    # Zombie: two straight arms towards camera, shoulder-height wrists;
    # world landmarks z is negative toward camera. Needs calibration by setup.
    if world and all(visible(p[i]) for i in (11, 12, 13, 14, 15, 16)):
        def forward_arm(s, e, w):
            dz = world[w].z - world[s].z
            return (dz < -0.12 and
                    abs(p[w].y - p[s].y) < torso_h * 0.50 and
                    abs(p[w].x - p[s].x) < shoulders_width * 1.0 and
                    (world[e].z - world[s].z) < -0.04)
        if forward_arm(11, 13, 15) and forward_arm(12, 14, 16):
            return 'STOP'

    # Detect one arm raised over head, highest priority among movement poses.
    if any(p[w].y < p[s].y - torso_h * 0.62 and p[e].y < p[s].y - torso_h * 0.17
           for s, e, w in ((11, 13, 15), (12, 14, 16))):
        return 'FORWARD'

    # Horizontal arm on either side: image has been mirrored (visual left = left).
    if (min(lw.x, rw.x) < min(ls.x, rs.x) - shoulders_width * 0.75 and
        min(abs(lw.y - ls.y), abs(rw.y - rs.y)) < torso_h * 0.65):
        return 'LEFT'
    if (max(lw.x, rw.x) > max(ls.x, rs.x) + shoulders_width * 0.75 and
        min(abs(lw.y - ls.y), abs(rw.y - rs.y)) < torso_h * 0.65):
        return 'RIGHT'

    # Downward extension. A naturally lowered arm also counts as BACK by design.
    if any(p[w].y > p[s].y + torso_h * 0.52 and p[e].y > p[s].y + torso_h * 0.22
           for s, e, w in ((11, 13, 15), (12, 14, 16))):
        return 'BACK'
    return None


def detect_jump(p, now):
    """Estimate upward translation of torso against slow moving baseline.
    Webcam heuristics, not a trained jump classifier; expect calibration.
    """
    if any(not visible(p[i]) for i in (11, 12, 23, 24)):
        controls.last_sample = None
        return False
    shoulder_y = (p[11].y + p[12].y) / 2
    hip_y = (p[23].y + p[24].y) / 2
    torso_h = max(hip_y - shoulder_y, 0.12)
    center_y = (shoulder_y + hip_y) / 2
    scaled_y = center_y / torso_h
    if controls.baseline_y is None:
        controls.baseline_y = scaled_y
        controls.last_sample = (now, scaled_y)
        return False
    last = controls.last_sample
    controls.last_sample = (now, scaled_y)
    if last is None:
        return False
    elapsed = max(now - last[0], 0.02)
    upward_speed = (last[1] - scaled_y) / elapsed
    upward_displacement = controls.baseline_y - scaled_y
    # Recalibrate baseline slowly while person is relatively stable.
    if abs(upward_speed) < 0.25 and abs(upward_displacement) < 0.15:
        controls.baseline_y = controls.baseline_y * 0.995 + scaled_y * 0.005
    if controls.takeoff_wait:
        if upward_displacement < 0.025:
            controls.takeoff_wait = False
        return False
    if upward_displacement > JUMP_RISE and upward_speed > JUMP_UP_SPEED:
        controls.takeoff_wait = True
        return True
    return False


def draw_pose(frame, points):
    h, w = frame.shape[:2]
    for a, b in DRAW_CONNECTIONS:
        if visible(points[a]) and visible(points[b]):
            axy = (int(points[a].x * w), int(points[a].y * h))
            bxy = (int(points[b].x * w), int(points[b].y * h))
            cv2.line(frame, axy, bxy, (90, 230, 100), 2)
    for i in (11, 12, 13, 14, 15, 16, 23, 24, 25, 26):
        if visible(points[i]):
            cv2.circle(frame, (int(points[i].x * w), int(points[i].y * h)), 5, (0, 195, 255), -1)


def main():
    if os.name != 'nt':
        raise SystemExit('This first version supports Windows only.')
    if not MODEL.exists():
        raise SystemExit(f'Model not found: {MODEL}')
    camera = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)
    if not camera.isOpened():
        camera = cv2.VideoCapture(CAMERA_INDEX)
    if not camera.isOpened():
        raise SystemExit('Cannot open webcam. Check permissions or change BUNNY_CAMERA.')
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.start()
    print('Press K while Eaglercraft is focused to arm/pause; F9 emergency stop.')
    print('In the preview window, press Q or Esc to quit. Keep whole torso visible.')
    start = time.monotonic()
    try:
        with mp.tasks.vision.PoseLandmarker.create_from_options(options) as landmarker:
            while controls.running:
                ok, frame = camera.read()
                if not ok:
                    controls.stop()
                    break
                frame = cv2.flip(frame, 1)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                now = time.monotonic()
                timestamp_ms = int((now - start) * 1000)
                result = landmarker.detect_for_video(image, timestamp_ms)
                candidate = None
                if result.pose_landmarks:
                    points = result.pose_landmarks[0]
                    world = result.pose_world_landmarks[0] if result.pose_world_landmarks else None
                    visible_torso = all(visible(points[i]) for i in (11, 12, 23, 24))
                    if visible_torso:
                        controls.last_seen = now
                        candidate = classify(points, world)
                        if controls.armed and browser_in_foreground():
                            controls.update_candidate(candidate, now)
                            if detect_jump(points, now):
                                controls.pulse_jump(now)
                    draw_pose(frame, points)
                controls.tick(now)
                # Preview itself steals focus when clicked. K works as global hotkey.
                cv2.putText(frame, 'ARMED' if controls.armed else 'PAUSED',
                            (16, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.75,
                            (30, 220, 30) if controls.armed else (20, 80, 240), 2)
                cv2.putText(frame, f'Move: {controls.mode}   Pose: {candidate or "-"}',
                            (16, 62), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (250, 250, 250), 2)
                cv2.putText(frame, 'K arm/pause  F9 STOP  Q quit',
                            (16, 95), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 0), 2)
                cv2.imshow('BunnyAI - Eaglercraft body control', frame)
                if (cv2.waitKey(1) & 0xFF) in (ord('q'), 27):
                    break
    finally:
        controls.stop()
        listener.stop()
        camera.release()
        cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
