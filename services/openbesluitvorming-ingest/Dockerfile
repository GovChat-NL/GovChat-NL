FROM python:3.12-slim
WORKDIR /app
COPY openbesluitvorming-ingest/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home ingest && mkdir /state && chown ingest:ingest /state
COPY openbesluitvorming-ingest/worker.py .
COPY openbesluitvorming-statistics/metadata.py openbesluitvorming-statistics/state.py openbesluitvorming-statistics/catalog.py ./
USER ingest
ENTRYPOINT ["python", "/app/worker.py"]
CMD ["status"]
