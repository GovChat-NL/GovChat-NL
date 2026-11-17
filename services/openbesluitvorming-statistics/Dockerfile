FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY metadata.py state.py server.py catalog.py build_catalog.py ./
USER 10001:10001
EXPOSE 8092
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8092/healthz', timeout=3)"
CMD ["python", "server.py"]
