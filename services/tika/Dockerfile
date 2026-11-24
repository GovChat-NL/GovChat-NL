FROM apache/tika:3.2.3.0-full@sha256:21d8052de04e491ccf66e8680ade4da6f3d453a56d59f740b4167e54167219b7
# Standard tessdata_fast, immutable upstream revision; no runtime downloads.
COPY nld.traineddata /usr/share/tesseract-ocr/5/tessdata/nld.traineddata
RUN echo 'ced0e5e046a84c908a6aa7accbef9a232c4a5d9a8276691b81c6ee64d02963f6  /usr/share/tesseract-ocr/5/tessdata/nld.traineddata' | sha256sum -c -
COPY tika-config.xml /tika-config.xml
CMD ["-c", "/tika-config.xml"]
