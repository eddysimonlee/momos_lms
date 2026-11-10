// 11/10 v1.js ContentEdit(화면 검사)가 content_edit.py(서버 검사)와 같은 결과인지: content_edit_cases.json
const assert = require('assert'), fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'v1.js'), 'utf8');
const a = src.indexOf('// >>> content-edit-check'), b = src.indexOf('// <<< content-edit-check');
assert(a > 0 && b > a, 'content-edit-check 표시를 찾지 못함');
const ContentEdit = new Function(src.slice(a, b) + '\nreturn ContentEdit;')();
const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'content_edit_cases.json'), 'utf8'));
let n = 0;
for (const c of d.cases) { assert.deepStrictEqual(ContentEdit.check(c.part, c.asis, c.tobe, d.cited, d.others, d.terms, c.openReq), c.expect, c.name); n++; }
// 원본 표 칸 이름 목록도 서버와 같은 규칙
const content = JSON.parse(fs.readFileSync(path.join(__dirname, 'v1_content.json'), 'utf8'));
const { execFileSync } = require('child_process');
const py = JSON.parse(execFileSync('python3', ['-c', 'import json,content_edit as ce;print(json.dumps(ce.load(".")["terms"],ensure_ascii=False))'], {cwd: __dirname}).toString());
assert.deepStrictEqual(ContentEdit.termsOf(content.sections), py, 'terms');
const sec = Object.values(content.sections)[0];
const pyText = execFileSync('python3', ['-c', 'import json,sys,content_edit as ce;print(json.dumps(ce.section_text(json.loads(sys.stdin.read())),ensure_ascii=False))'], {cwd: __dirname, input: JSON.stringify(sec)}).toString();
assert.strictEqual(ContentEdit.sectionText(sec), JSON.parse(pyText), 'sectionText');
console.log(`content_edit_test.cjs: ${n}건 + 이름 목록 + 절 글 OK`);
