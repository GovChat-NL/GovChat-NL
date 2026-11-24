# Standard Tika and Dutch OCR data

The [Dockerfile](Dockerfile) extends digest-pinned Apache Tika 3.2.3 full only by
bundling the Dutch language file and [standard configuration](tika-config.xml).
No parser code or model logic is patched.

Dutch data: [tessdata_fast immutable source](https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/nld.traineddata).
SHA256: ced0e5e046a84c908a6aa7accbef9a232c4a5d9a8276691b81c6ee64d02963f6.
Upstream [Apache 2.0 license](https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/LICENSE).
Data is checked during build and never downloaded at runtime.
