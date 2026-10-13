"""Storage helpers the LMS needs from the former ERP projects module.

Only what onboarding and item collaboration use: the JSON metadata row
reader/writer, input text validation, the conflict error and the image
validator. Room directories and ERP membership are intentionally absent.
"""
import json
import struct
import zlib
from datetime import datetime, timezone
from pathlib import Path

MAX_IMAGE = 8 * 1024 * 1024
MAX_RECORD = 4 * 1024 * 1024
MAX_PIXELS = 40_000_000


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
