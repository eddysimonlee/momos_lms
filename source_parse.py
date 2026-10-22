"""원본 매뉴얼(docx)을 문서·절 단위로 읽어 JSON 색인을 만든다.

사용법:  python3 source_parse.py <docx 폴더 또는 파일>... [-o source_index.json] [--summary]

모모스 본점 매뉴얼은 공통 템플릿(표지 → 개정 이력 → 메타데이터 → 목차 → 번호 절)을 따른다.
이 스크립트는 그 뼈대를 그대로 읽어 다음을 뽑는다.
  document : 파일명·제목·문서 유형(SOP/GUI/FRM)·판본·개정일·상태 등 메타데이터, 개정 이력
  section  : 절 번호·제목·형태(기준표/단계표/서술/기록양식)·단락·표·사진 수·본문 해시·개체 후보
해시는 절 본문(단락 + 표 셀 글자)으로 계산하므로, 다음에 다시 돌렸을 때 해시가 바뀐 절만
"내용이 바뀐 절"이다. LLM은 쓰지 않는다. python-docx 만 필요하다.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone

try:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph
except ImportError:  # pragma: no cover
    sys.exit('python-docx 가 필요합니다:  pip install python-docx')

HEADING_STYLES = {'SOP 주제목', 'SOP 하위절', 'SOP STEP',
                  'Heading 1', 'Heading 2', 'Heading 3', 'GUI 장 제목', 'GUI 소제목'}  # 261021~ 문서는 워드 기본 제목·GUI 서식을 쓴다
NUMBERED = re.compile(r'^(\d+(?:\.\d+)*)\.?\s+(.+)$')
BLIP = './/{http://schemas.openxmlformats.org/drawingml/2006/main}blip'
TYPE_WORDS = {'SOP': '작업 절차서', 'GUI': '업무 가이드', 'FRM': '기록 양식'}


def nfc(s):
    return unicodedata.normalize('NFC', s or '')


def blocks(document):
    for child in document.element.body.iterchildren():
        if child.tag.endswith('}p'):
            yield 'p', Paragraph(child, document)
        elif child.tag.endswith('}tbl'):
            yield 't', Table(child, document)


def table_rows(table):
    rows = []
    for r in table.rows:
        cells, prev = [], object()
        for c in r.cells:  # 병합 셀은 같은 객체가 반복되므로 한 번만
            if c._tc is prev:
                continue
            prev = c._tc
            cells.append(nfc(c.text).strip())
        rows.append(cells)
    return rows


def kv_table(rows):
    """'메타 항목 | 값 | 메타 항목 | 값' 꼴을 dict 로."""
    out = {}
    for r in rows[1:] if rows and rows[0] and rows[0][0] == '메타 항목' else rows:
        for i in range(0, len(r) - 1, 2):
            if r[i]:
                out[r[i]] = r[i + 1]
    return out


def classify(doc_type, title, paragraphs, tables):
    if doc_type == 'FRM':
        return '기록양식'
    if tables:
        header = ' '.join(tables[0]['header'])
        if '단계' in header or '순서' in header:
            return '단계표'
        if sum(len(p) for p in paragraphs) < 200:
            return '기준표'
        return '서술+표'
    return '서술'


def parse(path):
    document = docx.Document(path)
    fn = nfc(os.path.basename(path))
    doc = {'file': fn, 'folder': nfc(os.path.basename(os.path.dirname(os.path.abspath(path)))),  # 원본 폴더(업무 분류)
           'title': None, 'type': None, 'cover': {}, 'metadata': {}, 'revisions': [], 'sections': []}
    m = re.search(r'_(SOP|GUI|FRM)', fn)
    doc['type'] = m.group(1) if m else None

    sections, cur = [], None

    def new_section(no, title, level):
        return {'no': no, 'title': title, 'level': level, 'paragraphs': [], 'tables': [], 'images': 0}

    # 본문 시작점: '목차' 뒤에는 목차 항목(번호 줄)이 이어지고, 그 다음에 문서명과 본문 절이 다시 나온다.
    # 첫 '문장'(번호 없고 마침표/'~다'로 끝나는 줄) 바로 앞의 마지막 '1. 목적' 줄부터가 본문이다.
    paras = [nfc(p.text).strip() for p in document.paragraphs]
    toc_at = next((i for i, t in enumerate(paras) if t == '목차'), -1)
    body_start = toc_at + 1
    if toc_at >= 0:
        first_sentence = next((i for i in range(toc_at + 1, len(paras))
                               if paras[i] and not NUMBERED.match(paras[i]) and (paras[i].endswith(('.', '다', '요', ')')) or len(paras[i]) > 40)), len(paras))
        ones = [i for i in range(toc_at + 1, first_sentence) if NUMBERED.match(paras[i]) and NUMBERED.match(paras[i]).group(1) == '1']
        if ones:
            body_start = ones[-1]
    phase = 'front'
    pidx = -1

    for kind, b in blocks(document):
        if kind == 'p':
            pidx += 1
            if pidx >= body_start:
                phase = 'body'
        if kind == 't':
            rows = table_rows(b)
            if not rows:
                continue
            first = rows[0][0] if rows[0] else ''
            if phase != 'body':
                if first == '문서번호':
                    for r in rows:
                        for i in range(0, len(r) - 1, 2):
                            if r[i]:
                                doc['cover'][r[i]] = r[i + 1]
                elif first == '차수':
                    for r in rows[1:]:
                        if any(r):
                            doc['revisions'].append(dict(zip(['rev', 'date', 'note', 'author', 'approver'], r + [''] * 5)))
                elif first == '메타 항목':
                    doc['metadata'] = kv_table(rows)
                elif len(rows) == 1 and len(rows[0]) == 1 and not doc['title']:
                    doc['title'] = rows[0][0]
                continue
            if cur is None:
                cur = new_section('0', '(머리말)', 0)
                sections.append(cur)
            cur['tables'].append({'header': rows[0], 'rows': rows[1:]})
            cur['images'] += len(b._tbl.findall(BLIP))
            continue

        text = nfc(b.text).strip()
        style = b.style.name if b.style is not None else ''
        imgs = len(b._p.findall(BLIP))
        if phase != 'body':
            continue
        if text == doc['title'] and cur is None:
            continue  # 본문 앞의 문서명 반복
        mnum = NUMBERED.match(text)
        is_heading = bool(text) and (style in HEADING_STYLES or (mnum and len(text) < 70 and style in ('Normal', 'SOP 본문')
                                                                      and not text.endswith(('.', '다', '요'))))
        if is_heading:
            if mnum:
                no, title = mnum.group(1), mnum.group(2).strip()
            else:
                no, title = '', text
            cur = new_section(no, title, no.count('.') + 1 if no else 1)
            sections.append(cur)
            continue
        if cur is None:
            cur = new_section('0', '(머리말)', 0)
            sections.append(cur)
        if text:
            cur['paragraphs'].append(text)
        cur['images'] += imgs

    md = doc['metadata']
    if not doc['title']:
        # 261020~ 표지: 'MOMOS COFFEE' 브랜드 줄 바로 다음 줄이 문서명이다.
        brand = next((i for i, t in enumerate(paras[:body_start]) if t.upper() == 'MOMOS COFFEE'), None)
        if brand is not None:
            doc['title'] = next((t for t in paras[brand + 1:body_start] if t), '')
    doc['title'] = doc['title'] or fn
    tw = md.get('문서 유형', '')
    for k, v in TYPE_WORDS.items():
        if k in tw or v in tw:
            doc['type'] = k
    doc['status'] = md.get('문서 상태')
    doc['site'] = md.get('적용 사업장')
    doc['audience'] = md.get('대상자')
    doc['doc_no'] = doc['cover'].get('문서번호') or None
    doc['enacted_at'] = doc['cover'].get('제정일') or None
    doc['effective_at'] = md.get('시행일')
    doc['related_sop'] = md.get('관련 SOP') or None
    doc['equipment'] = md.get('관련 설비') or None
    doc['keywords'] = [k.strip() for k in re.split(r'[·,]', md.get('키워드', '')) if k.strip()]
    if doc['revisions']:
        last = doc['revisions'][-1]
        doc['version'] = last['rev'].replace('편집본 ', '')
        doc['revised_at'] = last['date']
    else:
        doc['version'] = doc['revised_at'] = None
    doc['file_sha1'] = hashlib.sha1(open(path, 'rb').read()).hexdigest()

    for s in sections:
        body = '\n'.join(s['paragraphs'] + ['\t'.join(c for r in [t['header']] + t['rows'] for c in r) for t in s['tables']])
        s['chars'] = len(body.replace('\n', '').replace('\t', ''))
        s['hash'] = hashlib.sha1(body.encode('utf-8')).hexdigest()[:12]
        s['kind'] = classify(doc['type'], s['title'], s['paragraphs'], s['tables'])
        ents = []
        for t in s['tables']:
            if s['kind'] in ('기준표', '단계표') or (t['header'] and t['header'][0] in ('용어', '항목', '시설', '공간', '포지션명', '창고명', '비품·설비')):
                ents += [r[0] for r in t['rows'] if r and r[0] and len(r[0]) <= 20 and not r[0].isdigit()]
        s['entities'] = sorted(set(ents))
    doc['sections'] = sections
    doc['id'] = re.sub(r'[^0-9A-Za-z가-힣]+', '-', re.sub(r'_\d{6}|_(SOP|GUI|FRM).*$|\.docx$', '', fn)).strip('-')
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('paths', nargs='+')
    ap.add_argument('-o', '--out', default='source_index.json')
    ap.add_argument('--summary', action='store_true')
    a = ap.parse_args()
    files = []
    for p in a.paths:
        if os.path.isdir(p):
            files += sorted(os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith('.docx') and not f.startswith('~$'))
        else:
            files.append(p)
    docs = [parse(f) for f in files]
    out = {'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'documents': docs}
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    if a.summary:
        for d in docs:
            print(f"{d['id']} | {d['type']} | {d['title']} | {d['version']} {d['revised_at']} | 상태 {d['status']} | 절 {len(d['sections'])}")
            for s in d['sections']:
                print(f"   {s['no']:7s} {s['title'][:34]:36s} {s['kind']:5s} {s['chars']:5d}자 표{len(s['tables'])} 사진{s['images']} {s['hash']}  {('·'.join(s['entities']))[:60]}")
    print(f"→ {a.out}: 문서 {len(docs)}편, 절 {sum(len(d['sections']) for d in docs)}개")


if __name__ == '__main__':
    main()
