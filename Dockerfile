# Momos LMS — one container, Python stdlib server, sqlite on a mounted volume.
# python3 from the OS plus the PostgreSQL driver (python3-psycopg, python3-psycopg-pool) for Supabase mode
# and fpdf2 (python3-fpdf) for the per-item PDF; no pip.
#
# n3r: Build argument BASE_IMAGE=base.n3r.reg.navercorp.com/base/ubuntu:24.04 (Docker Hub is not reachable there),
#      replicas 1 (sqlite has one writer), volume at /data, env LMS_PUBLIC_URL=https://<ingress host>,
#      internal staging only: LMS_TRIAL=1 (trial accounts + role switcher). Health check: GET /api/health.
# Render: no build argument needed; attach a persistent disk at /data and leave LMS_TRIAL unset.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ERP_CACHE_DIR=/tmp/momos-lms \
    LMS_DATA_DIR=/data LMS_HOST=0.0.0.0 PORT=8080
# The n3r base image starts as a non-root user; package installation needs root, the server does not.
USER root
# dist-upgrade pulls the base image's pending security patches; image scanners flag them otherwise.
RUN apt-get update && apt-get dist-upgrade -y && apt-get install -y --no-install-recommends python3 python3-psycopg python3-psycopg-pool python3-fpdf ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home lms && mkdir -p /data && chown lms:lms /data
# CVE-2026-111497 (Seawall): python3-brotli 는 python3-fpdf → python3-fonttools 의 의존성으로 들어오는데,
# Ubuntu 수정판이어도 PKG-INFO 의 버전(1.1.0)으로 탐지된다. PDF 는 TTF 글꼴만 써서 brotli(WOFF2 전용)가 필요 없으므로
# 이 패키지만 뺀다(fonttools 는 brotli 가 없으면 WOFF2 만 못 쓴다). OS 의 libbrotli1 은 수정판(1.1.0-2ubuntu0.1) 이상인지 확인한다.
RUN set -e; if dpkg -s python3-brotli >/dev/null 2>&1; then dpkg --remove --force-depends python3-brotli; fi; \
    if python3 -c "import brotli" 2>/dev/null; then echo "python brotli module is still installed"; exit 1; fi; \
    v="$(dpkg-query -W -f='${Version}' libbrotli1 2>/dev/null || true)"; \
    if [ -n "$v" ]; then dpkg --compare-versions "$v" ge 1.1.0-2ubuntu0.1 || { echo "libbrotli1 $v < 1.1.0-2ubuntu0.1"; exit 1; }; fi
WORKDIR /app
COPY --chown=lms:lms server.py lms_store.py access.py invitations.py cloud.py manual_wiki.py workspace_items.py onboarding.py dev_seed.py v1_pdf.py works_auth.py ./
COPY --chown=lms:lms auth.js workspace_items.js onboarding.js styles.css ./
COPY --chown=lms:lms onboarding_course.json onboarding_reviews.json onboarding.html onboarding_login.html ./
COPY --chown=lms:lms v1.html v1.js v1_graph.html v1_content.json v1_lessons.json curriculum.json source_log.json source_manifest.json ./
COPY --chown=lms:lms wds/ ./wds/
COPY --chown=lms:lms assets/ ./assets/
COPY --chown=lms:lms v1_photos/ ./v1_photos/
COPY --chown=lms:lms icons/ ./icons/
# brotli 를 뺀 뒤에도 한글 PDF 가 만들어지는지 빌드 때 확인한다
RUN python3 -c "from fpdf import FPDF; p=FPDF(); p.add_font('P','','assets/fonts/Pretendard-Regular.ttf'); p.add_page(); p.set_font('P',size=12); p.cell(0,10,'모모스 PDF 점검'); assert bytes(p.output())[:4]==b'%PDF'"
USER lms
# No VOLUME instruction (company image rule DIA-3): the platform mounts /data itself — n3r Spec > Volume, Render > Disk.
EXPOSE 8080
CMD ["python3", "server.py"]
