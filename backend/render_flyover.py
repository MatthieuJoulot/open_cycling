#!/usr/bin/env python3
"""Headless flyover video render.

Driven by serve.py (see flyover_render_new / render_flyover_video): opens
the standalone frame-renderer page in headless Chrome through playwright,
walks the camera frame by frame, collects JPEG frames and assembles them
with ffmpeg. Completely off-screen — the user never has to watch
anything, and the render is far faster than real-time because frames are
grabbed as soon as tiles settle instead of at a fixed clock rate.
"""
import base64
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

RENDER_FPS = 24
FINALE_S = 5   # seconds of zoom-out at the end of the video
IDLE_MS = 6000  # per-frame timeout waiting for map idle


def render_flyover_video(render_id, activity_id, port=8080, width=1280, height=800, seconds=60):
    from playwright.sync_api import sync_playwright

    out_dir = Path(tempfile.gettempdir()) / "flyover_renders" / render_id
    out_dir.mkdir(parents=True, exist_ok=True)
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(exist_ok=True)
    status_file = out_dir / "status.json"
    video = out_dir / "out.mp4"

    def status(**kw):
        try:
            status_file.write_text(json.dumps(kw))
        except Exception:
            pass

    status(state="starting", frame=0, total=0, error=None)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome", headless=True,
            args=["--use-angle=metal", "--enable-gpu-rasterization"],
        )
        page = browser.new_page(viewport={"width": width, "height": height})
        page.goto(f"http://127.0.0.1:{port}/render/flyover_frame.html?id={activity_id}")

        # Wait for the page to be ready (map + track + POIs loaded).
        deadline = time.time() + 60
        while time.time() < deadline:
            ready = page.evaluate("window.ready")
            err = page.evaluate("window.error")
            if err:
                browser.close()
                status(state="error", frame=0, total=0, error=str(err))
                return None
            if ready:
                break
            time.sleep(0.5)
        else:
            browser.close()
            status(state="error", frame=0, total=0, error="map load timeout")
            return None

        total_m = page.evaluate("window.totalM")
        frames = max(2, round(RENDER_FPS * seconds))
        # 5 s finale: drone pulls out to show the whole ride.
        finale_frames = FINALE_S * RENDER_FPS
        status(state="rendering", frame=0, total=frames + finale_frames, error=None)

        for f in range(frames):
            data_url = page.evaluate(
                "([f, n, ms]) => window.renderRideFrame(f, n, ms)",
                [f, frames, IDLE_MS],
            )
            # data:image/jpeg;base64,<payload>
            raw = base64.b64decode(data_url.split(",", 1)[1])
            (frames_dir / f"frame_{f:05d}.jpg").write_bytes(raw)
            status(state="rendering", frame=f + 1, total=frames + finale_frames, error=None)

        for f in range(finale_frames):
            data_url = page.evaluate(
                "([f, n, ms]) => window.renderFinaleFrame(f, n, ms)",
                [f, finale_frames, IDLE_MS],
            )
            raw = base64.b64decode(data_url.split(",", 1)[1])
            (frames_dir / f"frame_{frames + f:05d}.jpg").write_bytes(raw)
            status(state="rendering", frame=frames + f + 1,
                   total=frames + finale_frames, error=None)

        browser.close()

    status(state="encoding", frame=frames, total=frames, error=None)
    try:
        subprocess.run([
            "ffmpeg", "-y", "-framerate", str(RENDER_FPS),
            "-i", str(frames_dir / "frame_%05d.jpg"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-movflags", "+faststart", str(video),
        ], check=True, capture_output=True, timeout=1800)
    except Exception as e:
        status(state="error", frame=frames, total=frames, error=str(e))
        return None

    shutil.rmtree(frames_dir, ignore_errors=True)
    status(state="done", frame=frames, total=frames, error=None, video=str(video))
    return video


if __name__ == "__main__":
    # CLI: render_flyover.py <activity_id> [seconds] [render_id]
    activity_id = sys.argv[1]
    seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    rid = sys.argv[3] if len(sys.argv) > 3 else "cli"
    out = render_flyover_video(rid, activity_id, seconds=seconds)
    print("done" if out else "failed", out or "")
