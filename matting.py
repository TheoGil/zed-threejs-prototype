"""People's alpha matte for each frame, from Robust Video Matting (RVM).

RVM (https://github.com/PeterL1n/RobustVideoMatting) is a neural network that cuts people
out of video, with soft edges (hair, hands). It keeps a memory across frames, so its matte
is steady over time. It is GPL-3.0 licensed.

Runs with ONNX Runtime on DirectML (any DirectX 12 GPU on Windows), on the high-performance
GPU of a laptop with two. Needs:
    .venv\\Scripts\\python -m pip install onnxruntime-directml
    curl.exe -L -o models/rvm_mobilenetv3_fp32.onnx https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx

The full-precision model is used on purpose: the half-precision one infers a few ms faster,
but converting each frame to half precision on the CPU costs more than that.
"""

from pathlib import Path

import cv2
import numpy as np

MODEL = Path(__file__).parent / "models" / "rvm_mobilenetv3_fp32.onnx"


class Matting:
    def __init__(self):
        """Raises RuntimeError if ONNX Runtime or the model is missing."""
        try:
            import onnxruntime as ort
        except ImportError as e:
            raise RuntimeError("onnxruntime-directml is not installed") from e
        if not MODEL.exists():
            raise RuntimeError(f"the model is missing: {MODEL}")
        ort.set_default_logger_severity(3)  # no warnings about ops left on the CPU
        gpu = {"performance_preference": "high_performance", "device_filter": "gpu"}
        self.session = ort.InferenceSession(str(MODEL), providers=[("DmlExecutionProvider", gpu)])
        self.reset()

    def reset(self):
        """Forget the previous frames, e.g. after a scene switch."""
        self.states = [np.zeros((1, 1, 1, 1), np.float32)] * 4

    def run(self, bgr, ratio):
        """The alpha matte of `bgr` (HxWx3 uint8), HxW uint8 (255 = person).
        `ratio`: the share of the frame's resolution RVM works at internally."""
        src = cv2.dnn.blobFromImage(bgr, 1 / 255, swapRB=True)  # RGB, NCHW, 0..1, float32
        fgr, pha, *self.states = self.session.run(
            None,
            {
                "src": src,
                **{f"r{i + 1}i": state for i, state in enumerate(self.states)},
                "downsample_ratio": np.array([ratio], np.float32),
            },
        )
        return cv2.convertScaleAbs(pha[0, 0], alpha=255)
