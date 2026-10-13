FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ERP_CACHE_DIR=/tmp/momos-lms
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home lms
COPY server.py lms_store.py access.py invitations.py cloud.py manual_wiki.py workspace_items.py onboarding.py ./
COPY auth.js workspace_items.js onboarding.js styles.css ./
COPY onboarding_course.json onboarding_reviews.json onboarding.html onboarding_login.html ./
COPY assets/ ./assets/
COPY icons/ ./icons/
USER lms
EXPOSE 10000
CMD ["python", "-m", "cloud"]
