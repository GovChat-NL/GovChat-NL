FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home ingest && mkdir /state && chown ingest:ingest /state
COPY worker.py .
USER ingest
ENTRYPOINT ["python", "/app/worker.py"]
CMD ["status"]
