FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt requirements-inference.txt ./
RUN python -I -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.6.0+cpu \
    && python -I -m pip install --no-cache-dir -r requirements-inference.txt

COPY . .

# Explicit container-only opt-in; local app.py defaults to loopback.
# Inject MODEL_INTERNAL_TOKEN at runtime and mount the checkpoint read-only.
ENV HOST=0.0.0.0 PORT=5001 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
EXPOSE 5001

CMD ["python", "-I", "serve.py"]
