FROM node:24-bookworm-slim AS node
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ERP_CACHE_DIR=/tmp/momos-workspace
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home workspace
COPY server.py access.py invitations.py task_mail.py wbs_exchange.py project_materials.py source_review.py review_sync.py audio_review.py cloud.py projects.py pi_assets.py ./
COPY core_action.cjs core.js app.js auth.js workspace.js project_views.js followups.js projects.js workspace_help.js styles.css index.html manifest.webmanifest sw.js WBS_수정가이드.md ./
COPY assets/ ./assets/
COPY internal_interviews.json ./
COPY vendor_inbox.py vendor_inbox.js ./
COPY workspace_items.py workspace_items.js ./
COPY meeting_intake.py ./
COPY manual_wiki.py ./
COPY updates.html pi_example.html ./
COPY icons/ ./icons/
COPY onboarding.py onboarding_course.json onboarding_reviews.json onboarding.html onboarding_login.html onboarding.js ./
USER workspace
EXPOSE 10000
CMD ["python", "-m", "cloud"]
