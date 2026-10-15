# Momos LMS — one container, Python stdlib server, sqlite on a mounted volume.
# n3r: Stateful app, replicas 1 (sqlite has one writer), CephRBD volume mounted at /data,
# env LMS_PUBLIC_URL=https://<ingress host>. Health check: GET /api/health.
# Internal staging only: LMS_TRIAL=1 seeds the trial accounts and turns on the role switcher.
# Build argument so a build server can point at a company mirror instead of Docker Hub,
# e.g. n3r Build arguments: BASE_IMAGE=<mirror host>/library/python:3.12-slim-bookworm
ARG BASE_IMAGE=python:3.12-slim-bookworm
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ERP_CACHE_DIR=/tmp/momos-lms \
    LMS_DATA_DIR=/data LMS_HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home lms && mkdir -p /data && chown lms:lms /data
COPY server.py lms_store.py access.py invitations.py cloud.py manual_wiki.py workspace_items.py onboarding.py ./
COPY auth.js workspace_items.js onboarding.js styles.css ./
COPY onboarding_course.json onboarding_reviews.json onboarding.html onboarding_login.html ./
COPY v1.html v1.js v1_content.json ./
COPY wds/ ./wds/
COPY assets/ ./assets/
COPY icons/ ./icons/
USER lms
VOLUME ["/data"]
EXPOSE 8080
CMD ["python", "server.py"]
