# The gwei.domains publisher for GNS posts (gwei_poster.py). Build: docker build -t gwei-poster .
FROM python:3.12-slim

COPY requirements.txt /opt/gwei-poster/
RUN pip install --no-cache-dir -r /opt/gwei-poster/requirements.txt

# The mainnet KZG trusted setup (c-kzg-4844), pinned by hash. test_poster.py checks it reproduces
# real mainnet blob commitments.
ADD --checksum=sha256:d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7 \
    https://raw.githubusercontent.com/ethereum/c-kzg-4844/main/src/trusted_setup.txt /opt/gwei-poster/trusted_setup.txt
COPY gwei_poster.py /opt/gwei-poster/

RUN useradd --system --uid 10088 --home-dir /data gwei-poster && mkdir /data && chown gwei-poster /data
USER gwei-poster
WORKDIR /data
ENV PYTHONUNBUFFERED=1 POSTER_TRUSTED_SETUP=/opt/gwei-poster/trusted_setup.txt POSTER_DB=/data/poster.db
ENTRYPOINT ["python", "/opt/gwei-poster/gwei_poster.py"]
CMD ["run"]
