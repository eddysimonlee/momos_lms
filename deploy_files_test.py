"""11/10 배포 파일 점검: 서버가 import 하는 이 레포의 .py 가 모두 Dockerfile COPY 에 들어 있는지.
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


if __name__ == '__main__':
    unittest.main()
