FROM python:3.11-slim

WORKDIR /app

# Install Mem0 SDK + FastAPI server
RUN pip install --no-cache-dir mem0ai fastapi uvicorn pydantic

COPY operator/images/mem0/mem0_server.py /app/mem0_server.py

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

CMD ["uvicorn", "mem0_server:app", "--host", "0.0.0.0", "--port", "8080"]
