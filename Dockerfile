# Momos LMS — one container, Python stdlib server, sqlite on a mounted volume.
# Needs only python3 from the OS; the pip packages in requirements.txt belong to the old Supabase path.
#
# n3r: Build argument BASE_IMAGE=base.n3r.reg.navercorp.com/base/ubuntu:24.04 (Docker Hub is not reachable there),
#      replicas 1 (sqlite has one writer), volume at /data, env LMS_PUBLIC_URL=https://<ingress host>,
#      internal staging only: LMS_TRIAL=1 (trial accounts + role switcher). Health check: GET /api/health.
# Render: no build argument needed; attach a persistent disk at /data and leave LMS_TRIAL unset.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ERP_CACHE_DIR=/tmp/momos-lms \
    LMS_DATA_DIR=/data LMS_HOST=0.0.0.0 PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home lms && mkdir -p /data && chown lms:lms /data
WORKDIR /app
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
CMD ["python3", "server.py"]
