FROM govchat-tika-upload-adapter:test
USER root
COPY services/document-extractor/requirements-test.txt /test-requirements.txt
COPY services/document-extractor/requirements.txt /requirements.txt
RUN pip install --no-cache-dir -r /test-requirements.txt
COPY . /candidate
WORKDIR /candidate
CMD ["pytest", "-q", "tests/document-processing"]
