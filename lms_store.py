"""Storage helpers the LMS needs from the former ERP projects module.

Only what onboarding and item collaboration use: the JSON metadata row
reader/writer, input text validation, the conflict error and the image
validator. Room directories and ERP membership are intentionally absent.
"""
import json
import struct
import uuid
import zlib
from datetime import datetime, timezone
from pathlib import Path

MAX_IMAGE = 8 * 1024 * 1024
MAX_RECORD = 4 * 1024 * 1024
MAX_PIXELS = 40_000_000
# 11/25 변경 표시: 문서(metadata 행)마다 '마지막 저장' 작은 행을 하나씩 둔다(STAMP_BASE + 문서 id 끝자리).
# 화면은 이 작은 행만 물어보고(20초마다), 서버는 교육 기록을 다시 읽을지(캐시) 이것으로 정한다.
# 행이 문서마다 따로라 서로 다른 교육생의 저장이 같은 행을 두고 기다리지 않는다.
STAMP_BASE = 40_000_000_000
STAMP_SPAN = 1_000_000_000


def stamp_id(key):
    return STAMP_BASE + int(key) % STAMP_SPAN


def is_stamp(key):
    return STAMP_BASE <= int(key) < STAMP_BASE + STAMP_SPAN


def lock_learner(db, key):
    """11/25 교육생 한 명의 기록만 바꾸는 저장: 그 교육생 잠금만 잡는다(다른 교육생 저장과 동시에 진행).
    전체 설정(root)을 바꾸는 저장('BEGIN IMMEDIATE' = 전체 잠금)과는 겹치지 않게 전체 잠금을 '공유'로 함께 잡는다.
    로컬(SQLite)은 DB 하나를 통째로 잠그므로 예전처럼 BEGIN IMMEDIATE."""
    if getattr(db, 'raw', None) is not None:  # 클라우드(PostgreSQL)
        db.execute('SELECT pg_advisory_xact_lock_shared(730921, 1)')
        db.execute('SELECT pg_advisory_xact_lock(730922, CAST(? AS integer))', (int(key) % 2_000_000_000,))
    else:
        db.execute('BEGIN IMMEDIATE')


class Conflict(ValueError):
    pass


def stamp():
    return datetime.now(timezone.utc).isoformat()


def text(value, maximum=200, required=False):
    if not isinstance(value, str) or len(value.strip()) > maximum or (required and not value.strip()):
        raise ValueError('입력 내용의 길이와 필수 항목을 확인해 주세요.')
    return value.strip()


class Rooms:
    """Read and write one JSON document per metadata row."""

    @staticmethod
    def read(db, key):
        row = db.execute('SELECT body FROM metadata WHERE id=?', (key,)).fetchone()
        return json.loads(row[0]) if row else None

    @staticmethod
    def write(db, key, value):
        body = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(body.encode()) > MAX_RECORD:
            raise ValueError('교육 기록이 저장 한도에 도달했습니다. 기존 기록은 보존됩니다. 운영자에게 문의해 주세요.')
        db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', (key, body))
        if not is_stamp(key):  # 같은 거래 안에서 그 문서의 변경 표시도 바꾼다
            db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', (stamp_id(key), new_stamp()))

    @staticmethod
    def read_many(db, keys):
        """11/25 여러 문서를 조회 한 번에 → {id: 문서}. 없는 문서는 빠진다."""
        keys = list(dict.fromkeys(int(k) for k in keys))
        out = {}
        for i in range(0, len(keys), 500):
            part = keys[i:i + 500]
            for row in db.execute('SELECT id,body FROM metadata WHERE id IN (%s)' % ','.join('?' * len(part)), tuple(part)).fetchall():
                out[int(row[0])] = json.loads(row[1])
        return out

    @staticmethod
    def stamps(db, keys):
        """11/25 문서들의 변경 표시(조회 한 번) → {문서 id: 표시 또는 None}."""
        keys = [int(k) for k in keys]
        rows = Rooms.read_many(db, {stamp_id(k) for k in keys})
        return {k: (rows.get(stamp_id(k)) or {}).get('id') for k in keys}

    @staticmethod
    def change_stamp(db):
        """11/25 전체에서 가장 최근 변경 표시(작은 행들 중 가장 늦은 것, 조회 한 번)."""
        row = db.execute('SELECT max(body) FROM metadata WHERE id>=? AND id<?', (STAMP_BASE, STAMP_BASE + STAMP_SPAN)).fetchone()
        return json.loads(row[0]).get('id', '') if row and row[0] else ''


def new_stamp():
    return json.dumps(dict(at=stamp(), id=uuid.uuid4().hex))  # 'at' 이 앞이라 글자 순서 = 시간 순서(max)


def ensure_stamps(store):
    """11/25 서버 시작 때 한 번: 변경 표시가 없는 문서(이 기능 이전에 저장된 것)에 표시를 만든다. 몇 개 만들었는지 돌려준다."""
    with store.connect() as db:
        ids = [int(r[0]) for r in db.execute('SELECT id FROM metadata').fetchall()]
        have = {i for i in ids if is_stamp(i)}
        missing = {stamp_id(i) for i in ids if not is_stamp(i)} - have
        for sid in missing:
            db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', (sid, new_stamp()))
        return len(missing)


def image_info(raw, name):
    """Validate bounded PNG/JPEG structure without decoding or rewriting image pixels."""
    suffix = Path(name).suffix.lower()
    if not raw or len(raw) > MAX_IMAGE:
        raise ValueError('사진은 파일당 8MB 이하로 올려 주세요.')
    width = height = 0
    if suffix == '.png' and raw.startswith(b'\x89PNG\r\n\x1a\n'):
        offset, first, has_data, ended = 8, True, False, False
        while offset + 12 <= len(raw):
            length = struct.unpack('>I', raw[offset:offset + 4])[0]
            kind = raw[offset + 4:offset + 8]
            end = offset + 12 + length
            if end > len(raw):
                break
            content = raw[offset + 8:offset + 8 + length]
            crc = struct.unpack('>I', raw[offset + 8 + length:end])[0]
            if zlib.crc32(kind + content) & 0xffffffff != crc:
                raise ValueError('PNG 파일의 내용이 손상되었습니다.')
            if first:
                if kind != b'IHDR' or length != 13:
                    break
                width, height = struct.unpack('>II', content[:8])
                first = False
            elif kind == b'IHDR':
                break
            has_data = has_data or kind == b'IDAT'
            offset = end
            if kind == b'IEND':
                ended = length == 0 and offset == len(raw)
                break
        if not ended or not has_data:
            raise ValueError('정상적인 PNG 사진 파일을 선택해 주세요.')
        mime = 'image/png'
    elif suffix in ('.jpg', '.jpeg') and raw.startswith(b'\xff\xd8') and raw.endswith(b'\xff\xd9'):
        offset, has_scan = 2, False
        sof = {0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf}
        while offset + 4 <= len(raw):
            if raw[offset] != 0xff:
                break
            while offset < len(raw) and raw[offset] == 0xff:
                offset += 1
            if offset >= len(raw):
                break
            marker = raw[offset]
            offset += 1
            if marker in (0xd8, 0xd9, 0x00) or 0xd0 <= marker <= 0xd7:
                break
            length = int.from_bytes(raw[offset:offset + 2], 'big')
            if length < 2 or offset + length > len(raw):
                break
            if marker in sof:
                if length < 8:
                    break
                height, width = struct.unpack('>HH', raw[offset + 3:offset + 7])
            if marker == 0xda:
                has_scan = True
                break
            offset += length
        if not has_scan or not width or not height:
            raise ValueError('정상적인 JPEG 사진 파일을 선택해 주세요.')
        mime = 'image/jpeg'
    else:
        raise ValueError('PNG 또는 JPEG 원본 사진을 선택해 주세요.')
    if not 1 <= width <= 16000 or not 1 <= height <= 16000 or width * height > MAX_PIXELS:
        raise ValueError('사진 해상도는 가로·세로 16,000픽셀 및 4,000만 화소 이하로 올려 주세요.')
    return dict(mime=mime, width=width, height=height)
