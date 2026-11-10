"""11/10 배포 파일 점검: 서버가 import 하는 이 레포의 .py 가 모두 Dockerfile COPY 에 들어 있는지,
COPY 하는 파일이 .dockerignore(모두 빼고 ! 로 적은 것만 넣음)에서 빠지지 않는지.
(content_edit.py 를 COPY 에 넣지 않아 알파 배포가 'No module named content_edit' 로 멈춘 일 뒤에 추가)"""
import ast
import re
import unittest
from pathlib import Path

APP = Path(__file__).parent


class DeployFiles(unittest.TestCase):
    def test_server_imports_are_copied(self):
        docker = (APP / 'Dockerfile').read_text(encoding='utf-8')
        copied = set()
        for line in docker.splitlines():
            if line.startswith('COPY '):
                copied |= {p for p in line.split()[1:-1] if not p.startswith('--')}
        local = {p.stem for p in APP.glob('*.py')}
        todo, seen = ['server.py'], set()
        while todo:
            f = todo.pop()
            if f in seen: continue
            seen.add(f)
            self.assertIn(f, copied, f'{f} 를 Dockerfile COPY 에 넣어 주세요(서버가 import 함)')
            for node in ast.walk(ast.parse((APP / f).read_text(encoding='utf-8'))):
                names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
                for n in names:
                    if n.split('.')[0] in local: todo.append(n.split('.')[0] + '.py')
        self.assertIn('content_edit.py', seen)

    def test_copied_files_pass_dockerignore(self):
        """.dockerignore 는 '**' 로 모두 뺀 뒤 '!이름' 으로 넣는다. COPY 하는 파일·폴더마다 '!이름' 이 있어야 빌드에 전달된다."""
        docker = (APP / 'Dockerfile').read_text(encoding='utf-8')
        keep = {l.strip()[1:] for l in (APP / '.dockerignore').read_text(encoding='utf-8').splitlines() if l.strip().startswith('!')}
        for line in docker.splitlines():
            if line.startswith('COPY '):
                for p in line.split()[1:-1]:
                    if p.startswith('--'): continue
                    self.assertIn(p, keep, f"{p} 를 .dockerignore 에 '!{p}' 로 넣어 주세요(없으면 빌드에 전달되지 않음)")


if __name__ == '__main__':
    unittest.main()
