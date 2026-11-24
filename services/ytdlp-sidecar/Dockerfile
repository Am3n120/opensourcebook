FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
# wireproxy: userspace WireGuard (gVisor netstack) exposing a local SOCKS5 proxy
# for the WARP egress layer — no TUN device or capabilities required.
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgomp1 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && arch="${TARGETARCH:-amd64}" \
    && curl -fsSL "https://github.com/windtf/wireproxy/releases/download/v1.1.3/wireproxy_linux_${arch}.tar.gz" \
       | tar xz -C /usr/local/bin wireproxy
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# Bake the whisper model into the image: the first /transcribe request loads
# from disk instead of downloading the model from Hugging Face mid-request.
# "base" int8 is what is baked and loaded. It was chosen on the lite instance
# (~1 GiB), which OOM-disconnected mid-inference with "small". wrangler.toml
# now runs the container on standard-1, which has more headroom; the model
# stays base until "small" is measured there. Change it with
# --build-arg WHISPER_MODEL_SIZE=<size>.
ARG WHISPER_MODEL_SIZE=base
ENV WHISPER_MODEL_SIZE=${WHISPER_MODEL_SIZE}
RUN python -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL_SIZE'], device='cpu', compute_type='int8')"
COPY app.py guard.py entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh
# Optional, both gitignored: cookies.txt (a cookies file of the deployer's own choosing) and
# wgcf-profile.conf (a WireGuard profile for the egress tunnel). The full context copy
# keeps the build green whether or not the files exist.
COPY . /tmp/ctx
RUN cp /tmp/ctx/cookies.txt /app/cookies.txt 2>/dev/null || true; \
    cp /tmp/ctx/wgcf-profile.conf /app/wgcf-profile.conf 2>/dev/null || true; \
    rm -rf /tmp/ctx

EXPOSE 8080
CMD ["/app/entrypoint.sh"]
